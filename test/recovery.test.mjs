import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keccak256} from 'ethers';
import {reconcileRecordedCall,expiredCallMayRetry} from '../src/engine/agent_ui/recovery.mjs';
import {ExpiredOrders,orderStatePaths} from '../src/engine/agent_ui/expired_orders.mjs';
const wallet='0x'+'1'.repeat(40),target='0x'+'2'.repeat(40),hash='0x'+'3'.repeat(64),now=1800000000000;
const base={to:target,value:'0',inputHash:keccak256('0x1234'),fromBlock:100,startedMs:now-400000,
  stage:'sell_app_confirmation_pending',orderId:'123',intent:'order-1'};
function fixture({history={transactions:[],hasMore:false},lock='UNLOCKED',pending=1,tx=null,receipt=null}={}){
  const provider={getTransaction:async()=>tx,getTransactionReceipt:async()=>receipt,getTransactionCount:async(_,tag)=>tag==='latest'?1:pending};
  const cli=async args=>args[1]==='address'?{addresses:[{binanceChainId:'56',address:wallet}]}:args[1]==='tx-lock'?{status:lock}:history;
  return {provider,cli};
}
test('expired App confirmation clears only with complete history and matching unlocked nonces',async()=>{
  const f=fixture();assert.equal((await reconcileRecordedCall(f.provider,base,wallet,f.cli,now)).kind,'confirmation_closed');
  for(const options of [{lock:'LOCKED'},{pending:2},{history:{}},{history:{transactions:[],hasMore:true}}]){
    const x=fixture(options);assert.equal((await reconcileRecordedCall(x.provider,base,wallet,x.cli,now)).kind,'unresolved');
  }
  assert.equal((await reconcileRecordedCall(f.provider,{...base,startedMs:now-300000},wallet,f.cli,now)).kind,'unresolved');
  assert.equal((await reconcileRecordedCall(f.provider,{...base,stage:'sell_submission_unknown'},wallet,f.cli,now)).kind,'unresolved');
});
test('matching receipt wins over App timeout and unrelated history cannot claim success',async()=>{
  const tx={from:wallet,to:target,value:0n,chainId:56n,data:'0x1234'},receipt={status:1,blockNumber:110};
  const f=fixture({history:{transactions:[{txHash:hash}],hasMore:false},tx,receipt});
  const result=await reconcileRecordedCall(f.provider,base,wallet,f.cli,now);assert.equal(result.kind,'confirmed');assert.equal(result.txHash,hash);
  f.provider.getTransaction=async()=>({...tx,data:'0x5678'});
  assert.equal((await reconcileRecordedCall(f.provider,{...base,txHash:hash},wallet,f.cli,now)).kind,'unresolved');
  assert.equal(expiredCallMayRetry({settlement:{saleTxHash:hash}}),false);
  assert.equal(expiredCallMayRetry({quoteFunding:{buyTxHash:hash}}),false);
});
test('expired-order reconciliation closes the linked job without submitting or replaying a trade',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'agent-expired-')),token='0x'+'4'.repeat(40),job={id:'order-1',token,action:'sell',walletAddress:wallet,stage:'receipt_unresolved',events:[]};
  const paths=()=>orderStatePaths(job,{generic:dir});const path=paths()[0];writeFileSync(path,JSON.stringify(base));let saves=0;
  const f=fixture(),checker=new ExpiredOrders({...f,paths,save:()=>saves++});await checker.check([job],now);
  assert.equal(job.stage,'app_confirmation_expired');assert.equal(saves,1);
  assert.equal(JSON.parse(readFileSync(path)).stage,'confirmation_expired_unbroadcast');
  const other={...job,id:'other-order',stage:'receipt_unresolved',events:[]};await checker.check([other],now+11000);
  assert.equal(other.stage,'receipt_unresolved');
});
