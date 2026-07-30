const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

// 🔍 内容安全检测云函数
//   文本 -> cloud.openapi.security.msgSecCheck（同步，命中违规抛 errCode 87014）
//   图片 -> 腾讯云图片内容安全 IMS（ImageModeration，同步返回 Pass/Review/Block）
//
// ⚠️ 为什么图片用腾讯云 IMS：
//   微信 security.imgSecCheck(1.0) 已停止维护且实测失效；
//   security.mediaCheckAsync(2.0) 是异步接口，需"消息推送回调 + 前端轮询"，
//   无法在上传时"马上拦截"，审核场景不通过。
//   腾讯云 IMS 的 ImageModeration 为同步接口，一次调用即返回结论，
//   满足"上传违规图后立即拦截"。密钥通过云函数环境变量（IMS_*）注入，不写死在代码。

const VIOLATION_CODE = 87014;

// 腾讯云 IMS SDK（模块化包）
let ImsClient = null;
try {
  ImsClient = require("tencentcloud-sdk-nodejs-ims").ims.v20201229.Client;
} catch (e) {
  console.error("❌ 内容安全: 未安装 tencentcloud-sdk-nodejs-ims", e);
}

let imsClientCache = null;
function getImsClient() {
  // 从云函数环境变量读取（SCF 禁止以 SCF_/QCLOUD_/TENCENTCLOUD_ 开头，故用 IMS_ 前缀）
  const secretId = process.env.IMS_SECRET_ID;
  const secretKey = process.env.IMS_SECRET_KEY;
  const region = process.env.IMS_REGION || "ap-guangzhou";
  if (!secretId || !secretKey) {
    throw new Error("IMS_SECRET_ID / IMS_SECRET_KEY 未配置（请在云函数环境变量中配置）");
  }
  if (!ImsClient) {
    throw new Error("tencentcloud-sdk-nodejs-ims 未安装");
  }
  if (!imsClientCache) {
    imsClientCache = new ImsClient({
      credential: { secretId, secretKey },
      region,
      profile: { httpProfile: { endpoint: "ims.tencentcloudapi.com" } }
    });
  }
  return imsClientCache;
}

// 将云存储图片下载为 Base64（FileUrl 不可用时回退）
async function fileToBase64(fileID) {
  const dl = await cloud.downloadFile({ fileID });
  const buf = dl && dl.fileContent;
  if (!buf) throw new Error("下载图片失败");
  return buf.toString("base64");
}

/**
 * 同步图片安全检测（腾讯云 IMS）
 * @param {string} event.fileID   云存储 fileID
 * @param {string} event.bizType  控制台策略编号（可选，不传用默认策略）
 * @returns { success, safe, status('pass'|'risky'|'error'), label, subLabel, score }
 */
async function checkImageSync(event) {
  const fileID = event.fileID;
  if (!fileID) {
    return { success: false, safe: false, status: "error", error: "缺少 fileID" };
  }

  const urlRes = await cloud.getTempFileURL({
    fileList: [{ fileID, maxAge: 7200 }]
  });
  const item = urlRes && urlRes.fileList && urlRes.fileList[0];
  const mediaUrl = item && item.tempFileURL;
  if (!mediaUrl) {
    console.error("❌ 内容安全: 获取临时链接失败", urlRes);
    return { success: false, safe: false, status: "error", error: "无法获取图片访问链接" };
  }

  const bizType = event.bizType;
  // 构造检测参数：优先带 BizType（控制台策略），随后补一条「默认策略」兜底。
  // 避免某个 bizType 在 IMS 控制台未配置时（如 teamIcon）调用直接抛 InvalidParameter，
  // 导致所有图片被 fail-closed 一律拦截。回退到默认策略仍可正常出结论。
  const attempts = [{ FileUrl: mediaUrl }];
  if (bizType) attempts.unshift(Object.assign({ BizType: bizType }, { FileUrl: mediaUrl }));

  let lastErr = null;
  for (const params of attempts) {
    try {
      const client = getImsClient();
      let resp;
      try {
        // 优先用 FileUrl（云存储临时链接，≤30MB）；IMS 公网可下载
        resp = await client.ImageModeration(params);
      } catch (urlErr) {
        // FileUrl 不可用时回退 Base64（≤10MB）
        console.warn("⚠️ 内容安全: FileUrl 检测失败，回退 FileContent", urlErr && urlErr.message);
        const base64 = await fileToBase64(fileID);
        // 显式构造参数：去掉 FileUrl、改用 FileContent，避免传 undefined 给 SDK
        const fbParams = Object.assign({}, params);
        delete fbParams.FileUrl;
        fbParams.FileContent = base64;
        resp = await client.ImageModeration(fbParams);
      }

      const suggestion = resp && resp.Suggestion;
      const label = resp && resp.Label;
      const subLabel = resp && resp.SubLabel;
      const score = resp && resp.Score;
      console.log("📊 内容安全: IMS 结论", { bizType: params.BizType || "默认", suggestion, label, subLabel, score });

      if (suggestion === "Pass") {
        return { success: true, safe: true, status: "pass" };
      }
      if (suggestion === "Block" || suggestion === "Review") {
        return { success: true, safe: false, status: "risky", label, subLabel, score };
      }
      // 未知结论按拦截处理（fail-closed）
      console.warn("⚠️ 内容安全: IMS 返回未知 Suggestion，按拦截处理", suggestion);
      return { success: true, safe: false, status: "risky", label: label || "unknown", score };
    } catch (imsErr) {
      // 该策略失败（如 BizType 未配置），记录后尝试下一条兜底策略
      lastErr = imsErr;
      console.warn("⚠️ 内容安全: IMS 策略检测失败，尝试下一条", params.BizType || "默认", imsErr && imsErr.message);
    }
  }

  console.error("❌ 内容安全: IMS 所有策略均失败", lastErr);
  // 检测链路异常 → 拦截（fail-closed），避免违规漏过
  return { success: false, safe: false, status: "error", error: lastErr && lastErr.message };
}

exports.main = async (event, context) => {
  const { type } = event;
  const wxContext = cloud.getWXContext();

  try {
    // 图片：腾讯云 IMS 同步检测（'image' 兼容旧名，'imageSync' 为新名）
    if (type === "image" || type === "imageSync") {
      return await checkImageSync(event);
    }

    if (type === "text") {
      const content = event.content;
      const scene = event.scene || 2;
      // 空文本视为安全，避免无谓拦截
      if (!content || !String(content).trim()) {
        return { success: true, safe: true };
      }
      console.log("🔍 内容安全: 开始文本检测");
      await cloud.openapi.security.msgSecCheck({
        content: String(content),
        version: 2,
        scene: scene,
        openid: wxContext.OPENID
      });
      console.log("✅ 内容安全: 文本检测通过");
      return { success: true, safe: true };
    }

    return { success: false, error: "未知的检测类型: " + type };
  } catch (error) {
    const errCode = error && (error.errCode !== undefined ? error.errCode : error.errcode);
    if (errCode === VIOLATION_CODE) {
      console.log("⚠️ 内容安全: 命中违规内容");
      return { success: true, safe: false, status: "risky" };
    }
    // 检测链路异常（权限未开通 / 网络 / 配额等）→ 按"未通过检测"处理，
    // 由前端拦截发布，避免违规内容因检测失败而漏过
    console.error("❌ 内容安全: 接口调用异常", error);
    return { success: false, safe: false, status: "error", error: error.message };
  }
};
