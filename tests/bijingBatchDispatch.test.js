const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createAdminManagerCaller } = require('./helpers/adminManagerCaller');
const source = fs.readFileSync(require.resolve('../cloudfunctions/bijingSync/index.js'), 'utf8');
function harness(options = {}) {
  const calls = [], captured = {};
  const authorization = createAdminManagerCaller({ ...options,
    centralEnvironment: options.centralEnvironment || { ADMIN_STUDENT_NUMBERS: 'BJ0099' } });
  const clock = Date.parse(options.now || '2026-09-23T02:00:00+08:00');
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const environment = { BIJING_TIMER_ENABLED:'true',BIJING_TIMER_SOURCE:'wx_trigger',BIJING_API_BASE:'https://example.test',BIJING_ACCESS_TOKEN:'server-token',...options.env };
  const exports = {};
  const jobs = Object.fromEntries(['timer','start','processChunk','listRuns','details','listErrors','retryErrors'].map(name=>[name,async (...args)=> { calls.push({name,args}); return {status:'running',runId:'run'}; }]));
  vm.runInNewContext(source, {exports,Date:FixedDate,console:{error(){}},process:{env:environment}, require(name) {
    if(name==='wx-server-sdk') {
      const wxContext=options.context || {SOURCE:'wx_trigger'};
      return {init(){},DYNAMIC_CURRENT_ENV:'test',database:()=>authorization.delegationDb,getWXContext:()=>wxContext,
        callFunction:request=>authorization.call(request,wxContext)};
    }
    if(name==='axios') return {post: async (...args)=>{calls.push({name:'post',args}); return {data:{success:true}};}};
    if(name==='./maintenanceAuth') return require('../cloudfunctions/bijingSync/maintenanceAuth');
    if(name==='./batchJobs') return {BATCH_SIZE:20,createBatchJobs: deps=>{captured.deps=deps;return jobs;}};
    if(name==='./setup') return {initialize:async()=>{calls.push({name:'initialize'});return {};}};
    throw new Error(name);
  }});
  return {calls,captured,authRequests:authorization.requests,authUsers:authorization.authUsers,delegationDb:authorization.delegationDb,run:async(event)=>JSON.parse(JSON.stringify(await exports.main(event)))};
}

test('timer dispatch selects only completed days at the precise Beijing 02:00 boundary',async()=>{
  for(const [now,date] of [['2026-09-23T01:59:59.999+08:00','2026-09-21'],['2026-09-23T02:00:00+08:00','2026-09-22'],['2027-01-01T02:00:00+08:00','2026-12-31']]) {
    const app=harness({now}); assert.equal((await app.run({})).success,true);
    assert.equal(app.captured.deps.recentDates(1)[0],date);
    assert.deepEqual(app.calls,[{name:'timer',args:[]}]);
  }
});

test('batch adapter posts the daily records once with server-only credential and bounded timeout',async()=>{
  const app=harness();await app.run({type:'cronSyncAll'});
  const records=[{studentNumber:'BJ0001',durationMinutes:20}];
  await app.captured.deps.postBatch('2026-09-22',records);
  const call=JSON.parse(JSON.stringify(app.calls[1]));
  assert.deepEqual(call,{name:'post',args:['https://example.test/api/openapi/meditation/records/batch',{recordDate:'2026-09-22',records},{headers:{'X-Access-Token':'server-token'},timeout:15000}]});
});

test('reconciliation adapter queries actual person/date records with server-only credential',async()=>{
  const app=harness();await app.run({type:'cronSyncAll'});
  const records=[{studentNumber:'BJ0001',recordDate:'2026-09-22'}];
  await app.captured.deps.queryBatch(records);
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls[1])),{name:'post',args:[
    'https://example.test/api/openapi/meditation/records/query',{records},
    {headers:{'X-Access-Token':'server-token'},timeout:15000}
  ]});
});

for(const type of ['adminInitialize','adminStatus','adminStartSync','adminContinueSync','adminListSyncRuns','adminSyncDetails','adminListSyncErrors','adminRetrySyncErrors']) {
  test(`${type} rejects ordinary callers and timer identity before all business reads/writes`,async()=>{
    for(const context of [{OPENID:'ordinary',SOURCE:'wx_client'},{SOURCE:'wx_trigger'},{}]) {
      const app=harness({context});const result=await app.run({type,OPENID:'admin',admin:true});
      assert.equal(result.code,'FORBIDDEN');assert.deepEqual(app.calls,[]);assert.equal(app.captured.deps,undefined);
      assert.equal(result.error,'仅绑定指定管理员学号的账号可执行此操作');
    }
  });
  test(`${type} rejects obsolete OpenID configuration and ignores maintenance authorization`,async()=>{
    for(const ADMIN_OPENID of [undefined,'','admin','admin,other','admin other','admin;other']) {
      const app=harness({context:{OPENID:'admin'},centralEnvironment:{ADMIN_OPENID},
        env:{ADMIN_STUDENT_NUMBERS:'BJ0099',ADMIN_OPENIDS:'admin',MAINTENANCE_ADMIN_OPENIDS:'admin'}});
      const result=await app.run({type,ADMIN_OPENID:'admin',openid:'admin',admin:true});
      assert.equal(result.code,'FORBIDDEN');assert.deepEqual(app.calls,[]);assert.equal(app.captured.deps,undefined);
    }
  });
  test(`${type} accepts the second administrator and rejects outsiders under the student-number allowlist`,async()=>{
    const centralEnvironment={ADMIN_STUDENT_NUMBERS:'BJ0001,BJ0002'};
    const env={ADMIN_STUDENT_NUMBERS:'BJ0099,BJ0001,BJ0002',ADMIN_OPENID:'outsider',ADMIN_OPENIDS:'admin,outsider,maintenance,second-admin-extra',MAINTENANCE_ADMIN_OPENIDS:'maintenance'};
    const authorized=harness({context:{OPENID:'second-admin'},centralEnvironment,env});
    assert.equal((await authorized.run({type,recordDate:'2026-09-22',runId:'run'})).success,true);
    for(const context of [{OPENID:'outsider'},{OPENID:'admin'},{OPENID:'maintenance'},
      {OPENID:'second-admin-extra'},{SOURCE:'wx_trigger'},{}]) {
      const denied=harness({context,centralEnvironment,env});
      const result=await denied.run({type,OPENID:'second-admin',ADMIN_OPENIDS:'outsider',admin:true});
      assert.equal(result.code,'FORBIDDEN');assert.deepEqual(denied.calls,[]);assert.equal(denied.captured.deps,undefined);
    }
  });
}

test('sync start and retry preserve the second administrator SDK identity as the operator',async()=>{
  const app=harness({context:{OPENID:'second-admin'},centralEnvironment:{ADMIN_STUDENT_NUMBERS:'BJ0001,BJ0002'}});
  assert.equal((await app.run({type:'adminStartSync',recordDate:'2026-09-22',operator:'first-admin',OPENID:'first-admin'})).success,true);
  assert.equal((await app.run({type:'adminRetrySyncErrors',operator:'forged'})).success,true);
  assert.deepEqual(app.calls,[{name:'start',args:['2026-09-22','manual','second-admin']},{name:'retryErrors',args:['second-admin']}]);
});

test('all sync administration fails closed when central authorization is unavailable or malformed',async()=>{
  for(const type of ['adminInitialize','adminStatus','adminStartSync','adminContinueSync','adminListSyncRuns','adminSyncDetails','adminListSyncErrors','adminRetrySyncErrors']) {
    for(const failure of [{authError:new Error('private endpoint failure')},
      {authDatabaseError:new Error('private authorization database failure')},
      {authResponse:{result:{success:true,data:{isAdmin:'true'}}}},
      {authResponse:{result:{success:false,error:'private failure'}}}]) {
      const app=harness({...failure,context:{OPENID:'admin'},env:{ADMIN_OPENID:'admin',ADMIN_OPENIDS:'admin'}});
      assert.deepEqual(await app.run({type}),{success:false,code:'ADMIN_AUTH_UNAVAILABLE',error:'管理员权限校验暂时不可用，请稍后重试'});
      assert.deepEqual(app.calls,[]);assert.equal(app.captured.deps,undefined);assert.equal(app.authRequests.length,1);
    }
  }
});

test('sync administration waits for central authorization before creating or invoking batch jobs',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const app=harness({context:{OPENID:'admin'},beforeAuthorize:()=>gate});
  const pending=app.run({type:'adminStartSync',recordDate:'2026-09-22'});
  for(let turn=0;turn<20&&app.authRequests.length===0;turn++) await Promise.resolve();
  assert.equal(app.authRequests.length,1);assert.deepEqual(app.calls,[]);assert.equal(app.captured.deps,undefined);
  release();
  assert.equal((await pending).success,true);
  assert.equal(app.calls[0].name,'start');
});

test('central revocation takes effect on the next sync request without a local allowlist fallback',async()=>{
  const centralEnvironment={ADMIN_STUDENT_NUMBERS:'BJ0001,BJ0002'};
  const app=harness({context:{OPENID:'second-admin'},centralEnvironment,env:{ADMIN_STUDENT_NUMBERS:'BJ0002',ADMIN_OPENIDS:'second-admin'}});
  assert.equal((await app.run({type:'adminStatus'})).success,true);
  centralEnvironment.ADMIN_STUDENT_NUMBERS='BJ0001';
  assert.equal((await app.run({type:'adminStartSync',recordDate:'2026-09-22'})).code,'FORBIDDEN');
  assert.deepEqual(app.calls,[]);assert.equal(app.authRequests.length,2);
});

test('unbinding revokes synchronization administration before the next batch can start',async()=>{
  const app=harness({context:{OPENID:'second-admin'},centralEnvironment:{ADMIN_STUDENT_NUMBERS:'BJ0002'}});
  assert.equal((await app.run({type:'adminStatus'})).success,true);
  app.authUsers.find(user=>user._openid==='second-admin').bijingBound=false;
  for(const type of ['adminInitialize','adminStatus','adminStartSync','adminContinueSync','adminListSyncRuns','adminSyncDetails','adminListSyncErrors','adminRetrySyncErrors']) {
    assert.equal((await app.run({type,studentNumber:'BJ0002',bijingBound:true})).code,'FORBIDDEN');
  }
  assert.deepEqual(app.calls,[]);
});

test('duplicate historical student numbers cannot start or retry synchronization as either account',async()=>{
  for(const openid of ['second-admin','duplicate']) {
    const app=harness({context:{OPENID:openid},centralEnvironment:{ADMIN_STUDENT_NUMBERS:'BJ0002'}});
    app.authUsers.push({_id:'auth-duplicate',_openid:'duplicate',bijingBound:true,bijingStudentNumber:' bj0002 '});
    for(const type of ['adminStartSync','adminRetrySyncErrors']) assert.equal((await app.run({type})).code,'FORBIDDEN');
    assert.deepEqual(app.calls,[]);assert.equal(app.captured.deps,undefined);
  }
});

test('a one-time server proof authorizes synchronization when the nested SDK omits OPENID',async()=>{
  const app=harness({context:{OPENID:'second-admin'},centralContext:{},
    centralEnvironment:{ADMIN_STUDENT_NUMBERS:'BJ0001,BJ0002'}});
  assert.equal((await app.run({type:'adminStartSync',recordDate:'2026-09-22',
    expectedOpenid:'first-admin',delegationId:`auth_${'0'.repeat(64)}`,operator:'first-admin'})).success,true);
  assert.deepEqual(app.calls,[{name:'start',args:['2026-09-22','manual','second-admin']}]);
  assert.equal(app.authRequests[0].data.expectedOpenid,'second-admin');
  assert.match(app.authRequests[0].data.delegationId,/^auth_[a-f0-9]{64}$/);
  assert.notEqual(app.authRequests[0].data.delegationId,`auth_${'0'.repeat(64)}`);
  const proof=await app.delegationDb.collection('bijing_bindings').doc(app.authRequests[0].data.delegationId).get();
  assert.equal(proof.data,undefined);
});

test('a substituted nonempty nested platform identity cannot authorize synchronization',async()=>{
  const app=harness({context:{OPENID:'second-admin'},centralContext:{OPENID:'first-admin',SOURCE:'wx_client,scf'},
    centralEnvironment:{ADMIN_STUDENT_NUMBERS:'BJ0001,BJ0002'}});
  assert.equal((await app.run({type:'adminStartSync',recordDate:'2026-09-22'})).code,'FORBIDDEN');
  assert.deepEqual(app.calls,[]);assert.equal(app.captured.deps,undefined);
});

test('verified timer, maintenance dispatch and ordinary user operations never depend on central authorization',async()=>{
  const failure={authError:new Error('authorization service unavailable')};
  const timer=harness(failure);
  assert.equal((await timer.run({type:'cronSyncAll'})).success,true);
  assert.deepEqual(timer.authRequests,[]);
  const maintenance=harness({...failure,context:{OPENID:'maintenance'},env:{MAINTENANCE_ADMIN_OPENIDS:'maintenance'}});
  assert.equal((await maintenance.run({type:'cronSyncAll'})).success,true);
  assert.deepEqual(maintenance.authRequests,[]);
  const ordinary=harness({...failure,context:{OPENID:'ordinary'}});
  assert.deepEqual(await ordinary.run({type:'checkStudentNumber',studentNumber:''}),{success:false,error:'学号不能为空'});
  assert.deepEqual(ordinary.authRequests,[]);
});

test('administrator status exposes configuration health without exposing API secrets',async()=>{
  const app=harness({context:{OPENID:'admin'},env:{BIJING_TIMER_ENABLED:'false'}});
  const result=await app.run({type:'adminStatus'});
  assert.equal(result.success,true); assert.equal(result.data.timerEnabled,false);assert.equal(result.data.apiConfigured,true);
  assert.equal(result.data.dates.length,30);assert.equal(result.data.latestDate,'2026-09-22');
  assert.equal(JSON.stringify(result).includes('server-token'),false);assert.equal(JSON.stringify(result).includes('example.test'),false);
});

test('administrator routing forwards only intended action fields and platform operator identity',async()=>{
  const app=harness({context:{OPENID:'admin'}});
  await app.run({type:'adminStartSync',recordDate:'2026-09-22',operator:'forged'});
  await app.run({type:'adminContinueSync',runId:'run'});
  await app.run({type:'adminListSyncRuns'});
  await app.run({type:'adminSyncDetails',runId:'run',cursor:'after'});
  await app.run({type:'adminListSyncErrors',cursor:'after'});
  await app.run({type:'adminRetrySyncErrors',operator:'forged',recordDate:'1900-01-01'});
  assert.deepEqual(app.calls,[{name:'start',args:['2026-09-22','manual','admin']},{name:'processChunk',args:['run']},{name:'listRuns',args:[undefined,undefined]},{name:'details',args:['run','after']},{name:'listErrors',args:['after']},{name:'retryErrors',args:['admin']}]);
});

test('deployment keeps the daily 02:00 trigger and independent five-minute continuation',()=>{
  const config=require('../cloudfunctions/bijingSync/config.json');
  assert.deepEqual(config.triggers,[{name:'dailySyncBijing',type:'timer',config:'0 0 2 * * * *'},{name:'resumeBijingBatches',type:'timer',config:'0 */5 * * * * *'}]);
});

test('setup creates binding ownership and operational collections including unresolved errors and surfaces real failures',async()=>{
  const {initialize,COLLECTIONS}=require('../cloudfunctions/bijingSync/setup');
  const names=[];const result=await initialize({createCollection:async name=>{names.push(name);if(name===COLLECTIONS[0]) throw new Error('collection already exists');}});
  assert.deepEqual(names,COLLECTIONS);assert.equal(result.collections[0].created,false);
  assert.equal(COLLECTIONS.length,6);assert.ok(COLLECTIONS.includes('bijing_bindings'));assert.ok(COLLECTIONS.includes('bijing_sync_errors'));
  await assert.rejects(initialize({createCollection:async()=>{throw new Error('permission denied');}}),/permission denied/);
});
