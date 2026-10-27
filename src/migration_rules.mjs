import {randomUUID} from 'node:crypto';
import {getAddress,ZeroAddress} from 'ethers';
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
export function migrationOptions(raw){
  if(raw===undefined)return {enabled:false,recipient:null};
  if(!raw||Array.isArray(raw)||typeof raw!=='object'||typeof raw.enabled!=='boolean')throw Error('自动转出选项无效');
  if(!raw.enabled)return {enabled:false,recipient:null};
  const recipient=getAddress(raw.recipient);if(recipient===ZeroAddress)throw Error('收款地址不能为零地址');
  return {enabled:true,recipient};
}

// Each node watches only its own primary wallet. Peer nodes receive the buy
// options with the original order and monitor their own isolated session.
export class MigrationRules{
  constructor({read,write,orders,position,execute,reconcile,busy,canRun}){
    Object.assign(this,{write,orders,position,execute,reconcile,busy,canRun});this.rows=read();this.polling=false;
  }
  save(){this.write(this.rows);}
  list(){return this.rows.map(r=>({...r,pending:r.pending?{...r.pending}:null}));}
  stop(id){const r=this.rows.find(r=>r.id===id);if(!r)throw Error('未找到自动转出任务');
    r.enabled=false;r.stage=r.pending?'stopping_after_pending':'disabled';this.save();return r;}
  observe(jobs){const latest=new Map();
    for(const j of jobs){if((j.walletId||'primary')!=='primary'||j.action!=='buy'||!j.walletAddress)continue;
      const key=j.token.toLowerCase(),old=latest.get(key);if(!old||Date.parse(j.createdUtc)>Date.parse(old.createdUtc))latest.set(key,j);}
    for(const j of latest.values()){
      const old=this.rows.find(r=>same(r.token,j.token)&&same(r.wallet,j.walletAddress));if(old?.buyJobId===j.id)continue;
      if(old?.pending)continue;
      const option=migrationOptions(j.requested?.migration);
      if(!option.enabled){if(old){old.enabled=false;old.stage='disabled_on_new_buy';old.buyJobId=j.id;}continue;}
      const row={id:old?.id||randomUUID(),token:j.token,wallet:j.walletAddress,recipient:option.recipient,
        buyJobId:j.id,buyConfirmed:false,buyTxHash:null,txHash:null,lastReconciledAt:0,enabled:true,stage:'waiting_buy',pending:null,createdUtc:new Date().toISOString()};
      if(old)Object.assign(old,row);else this.rows.push(row);
    }
  }
  start(){if(this.timer)return;this.tick().catch(()=>{});this.timer=setInterval(()=>this.tick().catch(()=>{}),2000);this.timer.unref?.();}
  close(){clearInterval(this.timer);this.timer=null;}
  async tick(){if(this.polling)return;this.polling=true;
    const before=JSON.stringify(this.rows);
    try{const jobs=await this.orders();this.observe(jobs);
      for(const r of this.rows.filter(r=>r.enabled||r.pending)){
        try{
          if(r.pending){const j=jobs.find(j=>j.id===r.pending.jobId||j.requestId===r.pending.requestId);
            if(!j){r.stage='submission_unknown';continue;}
            r.pending.jobId=j.id;
            if(!j.running&&j.stage!=='confirmed'&&Date.now()-(r.lastReconciledAt||0)>=10000){r.lastReconciledAt=Date.now();await this.reconcile?.(j.id);}
            if(j.stage==='confirmed'){
              if(j.action!=='transfer'||!same(j.token,r.token)||!same(j.walletAddress,r.wallet)||!same(j.requested?.recipient,r.recipient)){r.enabled=false;r.stage='needs_attention';continue;}
              r.txHash=[...(j.events||[])].reverse().find(e=>e.stage==='transfer_confirmed')?.txHash||null;
              r.enabled=false;r.pending=null;r.stage='completed';continue;
            }
            if(!j.running){r.enabled=false;r.stage='needs_attention';continue;}
            r.stage=j.events?.some(e=>String(e.stage).endsWith('app_confirmation_pending'))?'waiting_app':'transferring';continue;
          }
          if(!this.canRun()){r.stage='paused_quote_only';continue;}
          if(!r.buyConfirmed){const buy=jobs.find(j=>j.id===r.buyJobId);
            if(!buy){r.enabled=false;r.stage='buy_history_missing';continue;}
            if(buy.running){r.stage='waiting_buy';continue;}
            if(!buy.events?.some(e=>['buy_confirmed','confirmed'].includes(e.stage))){r.enabled=false;r.stage='buy_not_filled';continue;}
            r.buyConfirmed=true;r.buyTxHash=[...buy.events].reverse().find(e=>e.txHash)?.txHash||null;}
          if(await this.busy()){r.stage='waiting_wallet';continue;}
          const p=await this.position(r);r.lastCheckedUtc=new Date().toISOString();
          if(!same(p.wallet,r.wallet))throw Error('wallet_identity_changed');
          if(p.phase!=='graduated'||!p.pair){r.stage='watching';continue;}
          if(BigInt(p.balanceRaw||0)===0n&&!p.needsClaim){r.enabled=false;r.stage='no_position';continue;}
          if(await this.busy()){r.stage='waiting_wallet';continue;}
          if(!r.enabled||!this.canRun())continue;
          const requestId=randomUUID();r.pending={requestId,jobId:null};r.stage='submitting';this.save();
          const result=await this.execute({action:'transfer',token:r.token,recipient:r.recipient,requestId,expectedWallet:r.wallet});
          const job=result.jobs?.[0];if(!job?.id){r.stage='submission_unknown';continue;}
          r.pending.jobId=job.id;r.stage='transferring';
        }catch(e){r.error=/^[a-z0-9_]+$/i.test(e.message)?e.message:'自动转出检查失败，请查看订单或钱包设置';
          if(r.pending){r.enabled=false;r.stage='needs_attention';}else r.stage='check_retrying';}
      }
      if(before!==JSON.stringify(this.rows))this.save();
    }finally{this.polling=false;}
  }
}
