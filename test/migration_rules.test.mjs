import test from 'node:test';import assert from 'node:assert/strict';
import {MigrationRules,migrationOptions} from '../src/migration_rules.mjs';
const token='0x'+'1'.repeat(40),wallet='0x'+'2'.repeat(40),recipient='0x'+'3'.repeat(40);
const buy=()=>({id:'buy-1',walletId:'primary',walletAddress:wallet,token,action:'buy',createdUtc:'2026-10-27T01:00:00Z',
  running:false,stage:'confirmed',events:[{stage:'buy_confirmed'}],requested:{migration:{enabled:true,recipient}}});
function setup(){const b=buy(),state={rows:[],jobs:[b],phase:'curve',live:true,calls:[]};
  const deps={read:()=>structuredClone(state.rows),write:rows=>state.rows=structuredClone(rows),orders:async()=>state.jobs,
    canRun:()=>state.live,busy:()=>false,position:async()=>({wallet,phase:state.phase,pair:state.phase==='graduated'?token:null,balanceRaw:'100',needsClaim:false}),
    execute:async input=>{state.calls.push(input);const job={id:'transfer-1',requestId:input.requestId,action:'transfer',token,walletAddress:wallet,requested:{recipient},running:true,stage:'transfer_broadcast',events:[]};state.jobs.push(job);return {jobs:[job]};}};
  return {state,deps,rules:new MigrationRules(deps)};
}
test('migration switch is opt-in and requires the user own recipient',()=>{
 assert.deepEqual(migrationOptions(),{enabled:false,recipient:null});assert.throws(()=>migrationOptions({enabled:true}));
 assert.throws(()=>migrationOptions({enabled:true,recipient:'0x'+'0'.repeat(40)}));assert.throws(()=>migrationOptions({enabled:'true'}));
});
test('only verified migration after confirmed buy starts one scoped transfer',async()=>{
 const {state,rules}=setup();await rules.tick();assert.equal(state.calls.length,0);assert.equal(rules.rows[0].stage,'watching');
 state.phase='graduated';await rules.tick();await rules.tick();assert.equal(state.calls.length,1);assert.equal(state.calls[0].recipient,recipient);
 assert.equal(state.calls[0].expectedWallet,wallet);
 const job=state.jobs[1];job.running=false;job.stage='confirmed';job.events=[{stage:'transfer_confirmed',txHash:'0x'+'a'.repeat(64)}];
 await rules.tick();assert.equal(rules.rows[0].stage,'completed');assert.equal(rules.rows[0].enabled,false);await rules.tick();assert.equal(state.calls.length,1);
});
test('lost response and restart reconcile the saved request instead of transferring twice',async()=>{
 const {state,deps,rules}=setup();state.phase='graduated';const send=deps.execute;
 rules.execute=async input=>{await send(input);throw Error('timeout');};await rules.tick();
 const restarted=new MigrationRules(deps);await restarted.tick();assert.equal(state.calls.length,1);assert.equal(restarted.rows[0].pending.jobId,'transfer-1');
 restarted.stop(restarted.rows[0].id);await restarted.tick();assert.equal(state.calls.length,1);
});
test('quote-only, failed buy, changed wallet and unchecked buys never cause a transfer',async()=>{
 for(const mode of ['quote','failed','wallet','unchecked']){
  const {state,rules}=setup();state.phase='graduated';
  if(mode==='quote')state.live=false;if(mode==='failed'){state.jobs[0].stage='error';state.jobs[0].events=[];}
  if(mode==='wallet')rules.position=async()=>({wallet:recipient,phase:'graduated',pair:token,balanceRaw:'100'});
  if(mode==='unchecked')state.jobs[0].requested.migration={enabled:false};await rules.tick();assert.equal(state.calls.length,0);
 }
});
test('peer wallets are monitored by their own node; stopping a rule does not resurrect it',async()=>{
 const {state,rules}=setup();state.jobs[0].walletId='wallet2';await rules.tick();assert.equal(rules.rows.length,0);
 state.jobs[0].walletId='primary';await rules.tick();rules.stop(rules.rows[0].id);state.phase='graduated';await rules.tick();assert.equal(state.calls.length,0);
 const newer={...buy(),id:'buy-2',createdUtc:'2026-10-27T02:00:00Z',requested:{migration:{enabled:false}}};state.jobs.push(newer);
 await rules.tick();assert.equal(rules.rows[0].stage,'disabled_on_new_buy');
});

test('confirmed buy survives order-log retention, and closing a rule during an RPC read prevents transfer',async()=>{
 const {state,rules,deps}=setup();await rules.tick();state.jobs=[];state.phase='graduated';
 const resumed=new MigrationRules(deps);await resumed.tick();assert.equal(state.calls.length,1);
 const second=setup();second.state.phase='graduated';second.rules.position=async()=>{
  second.rules.stop(second.rules.rows[0].id);return {wallet,phase:'graduated',pair:token,balanceRaw:'100'};};
 await second.rules.tick();assert.equal(second.state.calls.length,0);
});

test('a new buy cannot inherit the previous buy confirmed flag',async()=>{
 const {state,rules}=setup();await rules.tick();assert.equal(rules.rows[0].buyConfirmed,true);
 state.jobs.push({...buy(),id:'buy-2',createdUtc:'2026-10-27T02:00:00Z',running:true,events:[]});state.phase='graduated';
 await rules.tick();assert.equal(rules.rows[0].buyConfirmed,false);assert.equal(state.calls.length,0);
 state.jobs[1].running=false;state.jobs[1].stage='error';await rules.tick();assert.equal(state.calls.length,0);
});
