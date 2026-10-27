import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'agent-orders-'));
const {Jobs,validateOrder}=await import('../src/jobs.mjs');
const {settings,updateSettings,publicSettings}=await import('../src/config.mjs');
const token='0x'+'1'.repeat(40),address='0x'+'2'.repeat(40);
const makePool=()=>({records:[{id:'wallet2'}],cache:new Map(),get:id=>({id,label:id,local:id==='primary'}),
  status:async id=>({ready:id==='primary',address,error:'offline'}),request:async()=>{throw Error('offline');}});
test('per-wallet hard cap and explicit sell amount',()=>{
  assert.throws(()=>validateOrder({token,action:'buy',budgetBNB:'0.31'}));
  assert.throws(()=>validateOrder({token,action:'buy',budgetBNB:'0.300000000000000001'}));
  assert.throws(()=>validateOrder({token,action:'sell'}));
  assert.throws(()=>validateOrder({token,action:'buy',bps:0}));
  assert.deepEqual(validateOrder({token,action:'buy',walletIds:['primary','primary','wallet2']}).walletIds,['primary','wallet2']);
});
test('simultaneous wallets isolate failures and repeated requests never execute twice',async()=>{
  settings.liveTrading=true;const pool=makePool();let ran=0;
  const jobs=new Jobs({pool,provider:{},quote:()=>{},environment:()=>({}),detect:async()=>({platform:'gang',phase:'curve',token})});
  jobs.rows=[];jobs.run=row=>{ran++;row.stage='confirmed';row.running=false;jobs.locks.delete(row.walletId);};
  const order={token,action:'buy',walletIds:['primary','wallet2'],requestId:randomUUID()};
  const [a,b]=await Promise.all([jobs.submit(order),jobs.submit(order)]);
  assert.equal(ran,1);assert.equal(a.jobs[0].stage,'confirmed');assert.equal(a.jobs[1].stage,'error');
  assert.equal(b.jobs[0].id,a.jobs[0].id);
});
test('different concurrent requests serialize each wallet',async()=>{
  settings.liveTrading=true;const pool=makePool();let ran=0;
  pool.status=async()=>{await new Promise(r=>setTimeout(r,20));return {ready:true,address};};
  const jobs=new Jobs({pool,provider:{},quote:()=>{},environment:()=>({}),detect:async()=>({platform:'gang',phase:'curve',token})});jobs.rows=[];
  jobs.run=row=>{ran++;row.stage='buy_preview';};
  const [a,b]=await Promise.all([jobs.submit({token,action:'buy'}),jobs.submit({token,action:'buy'})]);
  assert.equal(ran,1);assert.equal(b.jobs[0].stage,'error');assert.equal(jobs.locks.get('primary'),a.jobs[0].id);
});
test('lost worker response blocks new purchases and reconciles the original request',async()=>{
  settings.liveTrading=true;const pool=makePool();pool.status=async()=>({ready:true,address});
  const jobs=new Jobs({pool,provider:{},quote:()=>{},environment:()=>({})});jobs.rows=[];
  const order={token,action:'buy',walletIds:['wallet2'],requestId:randomUUID()};
  const result=await jobs.submit(order);assert.equal(result.jobs[0].stage,'submission_unknown');
  assert.match((await jobs.submit({...order,requestId:randomUUID()})).jobs[0].events[0].error,/待核对订单/);
  pool.request=async()=>({jobs:[{id:randomUUID(),requestId:order.requestId,stage:'confirmed',running:false,events:[]}]});
  await jobs.list();assert.equal(result.jobs[0].stage,'confirmed');
});
test('settings never return a private RPC credential',()=>{
  updateSettings({rpcHttp:'https://example.com/secret-api-key'});
  assert(!JSON.stringify(publicSettings()).includes('secret-api-key'));
  assert.throws(()=>updateSettings({rpcHttp:'wss://example.com'}));
  assert.throws(()=>updateSettings({rpcHttp:'http://localhost'}));
});
