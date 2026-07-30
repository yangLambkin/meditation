// miniprogram/utils/contentSec.js
// 内容安全检测工具：封装微信官方 msgSecCheck(文本) / 腾讯云 IMS 同步图片检测
// 在「用户发布内容」入口的保存/发布前调用，命中违规返回 false 并提示。
// 命中违规的统一提示严格按审核指引第 2 点：仅告知「所发布内容含违规信息」，不披露细节。
//
// ⚠️ 图片检测说明：
//   微信 security.imgSecCheck(1.0) 已停止维护、mediaCheckAsync(2.0) 为异步无法满足
//   "上传即拦截"；现改用腾讯云图片内容安全 IMS 的 ImageModeration 同步接口，
//   云函数一次调用即返回 Pass/Review/Block，前端同步拿到结论后立即拦截，无需轮询。

const VIOLATION_TIP = '所发布内容含违规信息'

// 判断是否为需要检测的本地临时文件（微信体系内的网络图/云存储图不在此列）
function isLocalTempFile(path) {
  if (!path || typeof path !== 'string') return false
  return (
    path.startsWith('wxfile://tmp_') ||
    path.startsWith('wxfile://') ||
    path.startsWith('http://tmp/')
  )
}

// 取文件扩展名（忽略查询串），用于上传到云存储时拼 cloudPath
function getExt(filePath) {
  const clean = (filePath || '').split('?')[0]
  const m = clean.match(/\.([a-zA-Z0-9]+)$/)
  return m ? m[1].toLowerCase() : 'jpg'
}

// 压缩图片，减小上传与检测耗时；压缩失败则回退原图
function compressTempImage(filePath) {
  return new Promise((resolve) => {
    wx.compressImage({
      src: filePath,
      quality: 80,
      success: (res) => resolve(res.tempFilePath || filePath),
      fail: () => resolve(filePath)
    })
  })
}

/**
 * 检测已在云存储中的图片（同步，腾讯云 IMS）
 * @param {string} fileID cloud:// 文件 ID
 * @param {object} opts   { scene, bizType }
 * @returns {Promise<'pass'|'risky'|'error'>}
 */
async function checkCloudImage(fileID, opts = {}) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'contentSecCheck',
      data: {
        type: 'imageSync',
        fileID,
        scene: opts.scene || 1,
        bizType: opts.bizType || ''
      }
    })
    const result = res && res.result
    if (!result) return 'error'
    if (result.safe === true) return 'pass'
    // safe=false 时，error（检测链路异常）与 risky（命中违规）都按拦截处理
    return result.status === 'error' ? 'error' : 'risky'
  } catch (err) {
    console.error('图片安全检测异常:', err)
    return 'error'
  }
}

/**
 * 检测本地临时图片：上传 → 同步检测 → 立即返回
 * @param {string} tempFilePath 本地临时路径
 * @param {object} opts { scene, bizType, returnFileID }
 *   - returnFileID: true 时，检测通过返回已上传副本的 cloud:// fileID（供调用方直接复用，
 *     省去二次上传，且保证"被检测的文件 == 最终保存的文件"）；默认 false，返回 true/false
 * @returns {Promise<boolean|string>} 拦截返回 false；通过时默认 true，returnFileID 时返回 fileID
 */
async function checkImage(tempFilePath, opts = {}) {
  // 非本地临时文件（网络图/云存储图）不在发布侧检测范围
  if (!isLocalTempFile(tempFilePath)) return true

  let fileID
  wx.showLoading({ title: '安全检测中', mask: true })
  try {
    const compressed = await compressTempImage(tempFilePath)
    const ext = getExt(compressed)
    // cloudPrefix 指定上传落盘目录（如 avatar / team_icons）；默认 sec_check（临时检测副本）
    const prefix = (opts.cloudPrefix || 'sec_check').replace(/\/+$/, '')
    const uploadRes = await wx.cloud.uploadFile({
      cloudPath: `${prefix}/${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`,
      filePath: compressed
    })
    fileID = uploadRes.fileID

    const status = await checkCloudImage(fileID, {
      scene: opts.scene || 1,
      bizType: opts.bizType || ''
    })
    wx.hideLoading()

    if (status === 'risky') {
      wx.showToast({ title: VIOLATION_TIP, icon: 'none' })
      // 违规文件立即删除，防止违规图继续存在云存储
      wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {})
      return false
    }
    if (status === 'error') {
      // 检测链路异常 → 无法确认安全，fail-closed 拦截
      wx.showToast({ title: '内容安全检测暂不可用，请稍后重试', icon: 'none' })
      wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {})
      return false
    }
    // pass：命中 returnFileID 时返回该副本 fileID（调用方直接复用，省二次上传）；否则返回 true
    return opts.returnFileID ? fileID : true
  } catch (err) {
    wx.hideLoading()
    console.error('内容安全图片检测失败（已拦截）:', err)
    wx.showToast({ title: '内容安全检测暂不可用，请稍后重试', icon: 'none' })
    if (fileID) wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {})
    return false
  }
}

// 检测文本：返回 Promise<boolean>（true=安全，false=违规）
// scene: 1=资料(头像/昵称)，2=评论(经验笔记/团队名介绍)
async function checkText(text, scene = 2) {
  if (!text || !String(text).trim()) return true
  try {
    const res = await wx.cloud.callFunction({
      name: 'contentSecCheck',
      data: { type: 'text', content: String(text), scene }
    })
    const result = res && res.result
    if (!result || !result.success || !result.safe) {
      wx.showToast({ title: VIOLATION_TIP, icon: 'none' })
      return false
    }
    return true
  } catch (err) {
    console.error('内容安全文本检测失败:', err)
    return true
  }
}

module.exports = {
  checkImage,
  checkCloudImage,
  checkText,
  VIOLATION_TIP
}
