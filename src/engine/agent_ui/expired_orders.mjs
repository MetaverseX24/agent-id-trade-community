import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {reconcileRecordedCall,expiredCallMayRetry} from './recovery.mjs';
const CORE='0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3';
const blocked=new Set(['receipt_unresolved','submission_unknown','interrupted_check_chain','interrupted_check_chain_before_retry']);

// Read-only chain/SDK checks; only a proven expired, unbroadcast App request
// may be closed locally. This module never submits, cancels or signs a call.
export class ExpiredOrders{
  constructor({provider,cli,paths,save}){Object.assign(this,{provider,cli,paths,save});this.last=0;this.pending=null;}
  async check(rows,now=Date.now(),force=false){
    if(this.pending)return this.pending;
    if(!force&&now-this.last<10000)return;this.last=now;
    this.pending=this.run(rows,now).finally(()=>{this.pending=null;});return this.pending;
  }
  async run(rows,now){let changed=false;
    for(const job of rows){
      if(job.running||job.remoteId||(!blocked.has(job.stage)&&!String(job.stage).endsWith('app_confirmation_pending'))||!/^0x[0-9a-f]{40}$/i.test(job.walletAddress||''))continue;
      for(const path of this.paths(job)){
        try{
          if(!existsSync(path))continue;
          const state=JSON.parse(readFileSync(path,'utf8'));
          const linked=state.intent===job.id||path.endsWith(`-${job.id}.json`)||
            job.events?.some(e=>e.requestId&&e.requestId===state.requestId);
          if(!linked)continue;
          if(state.stage==='confirmation_expired_unbroadcast'&&state.reconciliation?.kind==='confirmation_closed'){
            job.stage='app_confirmation_expired';changed=true;break;
          }
          if(state.txHash||!String(state.stage).endsWith('app_confirmation_pending')||
            now-state.startedMs<330000||!expiredCallMayRetry(state))continue;
          const result=await reconcileRecordedCall(this.provider,{...state,to:state.to||(job.platform==='four'?CORE:null)},job.walletAddress,this.cli,now);
          if(result.kind!=='confirmation_closed')continue;
          const next={...state,stage:'confirmation_expired_unbroadcast',reconciliation:result,updatedUtc:new Date(now).toISOString()};
          writeFileSync(path+'.reconciled',JSON.stringify(next),{mode:0o600});renameSync(path+'.reconciled',path);
          job.stage='app_confirmation_expired';job.awaitingApproval=false;
          job.events.push({stage:'app_confirmation_expired',atUtc:next.updatedUtc,message:'手机确认已过期，已核对没有上链。需要交易时请重新点击。'});changed=true;break;
        }catch{/* An unavailable check never releases the order guard. */}
      }
    }
    if(changed)this.save();
  }
}
export function orderStatePaths(job,{generic,four}){
  const ca=String(job.token||'').toLowerCase();if(!/^0x[0-9a-f]{40}$/.test(ca))return [];
  return [join(generic,`${ca}-${job.action}.json`),...(four?[job.action==='sell'?join(four,`sell-${ca}.json`):join(four,`${ca}-${job.id}.json`)]:[])];
}
