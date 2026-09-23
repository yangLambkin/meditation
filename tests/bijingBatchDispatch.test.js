const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../cloudfunctions/bijingSync/index.js'), 'utf8');
function harness(options = {}) {
  const calls = [], captured = {};
  const clock = Date.parse(options.now || '2026-09-23T02:00:00+08:00');
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const environment = { BIJING_TIMER_ENABLED:'true',BIJING_TIMER_SOURCE:'wx_trigger',ADMIN_OPENID:'admin',BIJING_API_BASE:'https://example.test',BIJING_ACCESS_TOKEN:'server-token',...options.env };
  const exports = {};
  const jobs = Object.fromEntries(['timer','start','processChunk','listRuns','details','listErrors','retryErrors'].map(name=>[name,async (...args)=> { calls.push({name,args}); return {status:'running',runId:'run'}; }]));
  vm.runInNewContext(source, {exports,Date:FixedDate,console:{error(){}},process:{env:environment}, require(name) {
    if(name==='wx-server-sdk') return {init(){},database:()=>({}),getWXContext:()=>options.context || {SOURCE:'wx_trigger'}};
    if(name==='axios') return {post: async (...args)=>{calls.push({name:'post',args}); return {data:{success:true}};}};
    if(name==='./maintenanceAuth') return require('../cloudfunctions/bijingSync/maintenanceAuth');
    if(name==='./batchJobs') return {BATCH_SIZE:20,createBatchJobs: deps=>{captured.deps=deps;return jobs;}};
    if(name==='./setup') return {initialize:async()=>{calls.push({name:'initialize'});return {};}};
    throw new Error(name);
  }});
  return {calls,captured,run:async(event)=>JSON.parse(JSON.stringify(await exports.main(event)))};
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
  test(`${type} rejects ordinary callers and timer identity before all reads/writes`,async()=>{
    for(const context of [{OPENID:'ordinary',SOURCE:'wx_client'},{SOURCE:'wx_trigger'},{}]) {
      const app=harness({context});const result=await app.run({type,OPENID:'admin',admin:true});
      assert.equal(result.code,'FORBIDDEN');assert.deepEqual(app.calls,[]);assert.equal(app.captured.deps,undefined);
      assert.equal(result.error,'仅指定的管理员微信账号可执行此操作');
    }
  });
  test(`${type} requires one fixed ADMIN_OPENID and ignores legacy maintenance authorization`,async()=>{
    for(const ADMIN_OPENID of [undefined,'','admin,other','admin other','admin;other']) {
      const app=harness({context:{OPENID:'admin'},env:{ADMIN_OPENID,MAINTENANCE_ADMIN_OPENIDS:'admin'}});
      const result=await app.run({type,ADMIN_OPENID:'admin',openid:'admin',admin:true});
      assert.equal(result.code,'FORBIDDEN');assert.deepEqual(app.calls,[]);assert.equal(app.captured.deps,undefined);
    }
  });
}

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

test('setup creates all five operational collections including unresolved errors and surfaces real failures',async()=>{
  const {initialize,COLLECTIONS}=require('../cloudfunctions/bijingSync/setup');
  const names=[];const result=await initialize({createCollection:async name=>{names.push(name);if(name===COLLECTIONS[0]) throw new Error('collection already exists');}});
  assert.deepEqual(names,COLLECTIONS);assert.equal(result.collections[0].created,false);
  assert.equal(COLLECTIONS.length,5);assert.ok(COLLECTIONS.includes('bijing_sync_errors'));
  await assert.rejects(initialize({createCollection:async()=>{throw new Error('permission denied');}}),/permission denied/);
});
