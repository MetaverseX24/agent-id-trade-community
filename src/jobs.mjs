import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, ZeroAddress, parseEther } from 'ethers';
import { DATA, ROOT, settings, readData, writeData } from './config.mjs';
import { detectAgentToken } from './engine/agent_ui/platforms.mjs';
import { coreAbi } from './protocol_snapshot.mjs';
import { previewRiskState } from './engine/preview_policy.mjs';
import { makeWorkflowConsent } from './engine/agent_ui/workflow_consent.mjs';

export function validateOrder(input,maxBuy=settings.maxBuyBNB){
  const token=getAddress(input.token),action=input.action;
  if(!['buy','sell'].includes(action))throw Error('请选择买入或卖出');
  const walletIds=[...new Set(input.walletIds||['primary'])];
  if(!Array.isArray(input.walletIds||[])||!walletIds.length||walletIds.length>10)throw Error('请选择 1–10 个钱包');
  const mode=input.mode||'percent',bps=Number(input.bps??(action==='buy'?100:0));
  if(!Number.isInteger(bps)||bps<0||bps>(action==='buy'?200:10000)||((action==='sell'||mode==='percent')&&!bps))throw Error('比例无效');
  const budgetBNB=String(input.budgetBNB??maxBuy);
  if(action==='buy'&&(!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(budgetBNB)||parseEther(budgetBNB)<=0n||parseEther(budgetBNB)>parseEther(maxBuy)))throw Error('买入金额超过单钱包限额');
  if(action==='buy'&&!['percent','bnb'].includes(mode))throw Error('买入方式无效');
  return {token,action,mode,bps,budgetBNB,walletIds,requestId:input.requestId||randomUUID()};
}
export class Jobs extends EventEmitter{
  constructor({provider,pool,quote,environment,detect=detectAgentToken}){super();this.provider=provider;this.pool=pool;this.quote=quote;this.environment=environment;this.detect=detect;
    this.rows=readData('orders.json',[]);this.children=new Map();this.locks=new Map();
    for(const row of this.rows)if(row.running){row.running=false;row.stage='interrupted_check_chain';row.awaitingApproval=false;}
  }
  save(){writeData('orders.json',this.rows.slice(-200));this.emit('change');}
  async list(){await Promise.all(this.pool.records.map(async profile=>{
    const current=this.rows.filter(r=>r.walletId===profile.id&&(r.running||['submission_unknown','interrupted_check_chain'].includes(r.stage)));if(!current.length)return;
    try{const data=await this.pool.request(profile,'/worker/jobs');for(const local of current){const remote=data.jobs?.find(x=>x.id===local.remoteId||(x.requestId||x.clientRequestId)===local.requestId);
      if(remote){Object.assign(local,{remoteId:remote.id,stage:remote.stage,running:remote.running,awaitingApproval:remote.awaitingApproval,events:remote.events||[]});if(!local.running)this.locks.delete(profile.id);else this.locks.set(profile.id,local.id);}}this.save();}
    catch{for(const row of current)row.workerUnavailable=true;}
  }));return this.rows.slice(-60).reverse();}
  async submit(input){const order=validateOrder(input);order.walletIds.forEach(id=>this.pool.get(id));
    if(!/^[0-9a-f-]{36}$/i.test(order.requestId))throw Error('请求编号无效');
    const selectedAddresses=new Set();
    const result=await Promise.all(order.walletIds.map(async walletId=>{
      const prior=this.rows.find(r=>r.walletId===walletId&&r.requestId===order.requestId);if(prior)return prior;
      const profile=this.pool.get(walletId);let row={id:randomUUID(),requestId:order.requestId,walletId,walletLabel:profile.label,
        token:order.token,action:order.action,requested:order,createdUtc:new Date().toISOString(),events:[],stage:'preparing',running:true};
      this.rows.push(row);this.save();
      let remoteSubmitted=false;
      try{
        if(this.locks.has(walletId))throw Error('该钱包上一笔订单仍在执行');
        const unresolved=this.rows.find(r=>r.id!==row.id&&r.walletId===walletId&&['receipt_unresolved','interrupted_check_chain','submission_unknown'].includes(r.stage));
        if(unresolved)throw Error('该钱包有待核对订单，请先核对交易记录');
        this.locks.set(walletId,row.id);
        if(!settings.liveTrading){const status=this.pool.cache.get(walletId)?.value;
          const info=await this.detect(this.provider,order.token,coreAbi,status?.address||ZeroAddress);
          const q=await this.quote(info,{...order,address:status?.address||ZeroAddress});
          Object.assign(row,{platform:info.platform,stage:'quoted_only',running:false,
            events:[{stage:'quote',...q},{stage:'quoted_only',message:'当前为仅报价模式，没有请求签名或下单'}]});this.locks.delete(walletId);this.save();return row;}
        const status=await this.pool.status(walletId);
        if(!status.ready)throw Error(status.error||'钱包未连接或设置未就绪');
        const actual=status.address?.toLowerCase();if(!actual||selectedAddresses.has(actual))throw Error('同一个钱包地址不能重复下单');selectedAddresses.add(actual);
        if(!profile.local){remoteSubmitted=true;row.stage='worker_submitting';this.save();const data=await this.pool.request(profile,'/worker/trade',{...order,walletIds:['primary']});
          const remote=data.jobs?.[0];if(!remote?.id)throw Error('钱包节点未返回订单');
          Object.assign(row,{remoteId:remote.id,platform:remote.platform,stage:remote.stage,running:remote.running,events:remote.events||[]});
          if(!row.running)this.locks.delete(walletId);this.save();return row;}
        const info=await this.detect(this.provider,order.token,coreAbi,status.address);
        if(!['curve','standard_curve'].includes(info.phase)&&!info.pair)throw Error('当前交易路径未验证');
        if(order.action==='buy'&&order.bps>(info.platform==='flap'?200:100))throw Error('超过平台单钱包持仓上限');
        row.platform=info.platform;row.walletAddress=status.address;this.locks.set(walletId,row.id);
        this.run(row,info,order,status.address);return row;
      }catch(error){row.running=false;row.stage=remoteSubmitted?'submission_unknown':'error';row.events.push({stage:row.stage,error:remoteSubmitted?'节点响应超时，先核对原订单，禁止重新下单':String(error.message).replace(/https?:\/\/\S+/g,'[endpoint]')});
        if(this.locks.get(walletId)===row.id)this.locks.delete(walletId);this.save();return row;}
    }));return {groupId:order.requestId,jobs:result};
  }
  run(row,info,order,address){const engine=join(ROOT,'src','engine'),walletData=join(DATA,'wallets',row.walletId);
    row.workflowConsent=makeWorkflowConsent(info,order,address,row.id);this.save();
    mkdirSync(walletData,{recursive:true,mode:0o700});
    const baseline=join(DATA,'protocol-baseline.json');
    if(!existsSync(baseline))copyFileSync(join(engine,'abi','protocol-baseline.json'),baseline);
    const env={...this.environment(),AGENT_WALLET_ADDRESS:address,AGENT_MAX_BUY_BNB:settings.maxBuyBNB,
      AGENT_WORKFLOW_CONSENT:JSON.stringify(row.workflowConsent),
      AGENT_GAS_RESERVE_BNB:settings.gasReserveBNB,AGENT_SLIPPAGE_BPS:String(settings.slippageBps),
      OPENFOUR_BASELINE_STATE:baseline,OPENFOUR_MANUAL_STATE_DIR:join(walletData,'four-orders'),AGENT_TRADE_STATE_DIR:join(walletData,'orders')};
    let script,args;
    if(info.platform==='four'&&info.phase==='curve'){
      script=order.action==='buy'?'buy_agent_id_ca.mjs':'sell_agent_id_ca.mjs';
      args=[order.token,'--execute','--manual-confirm',...(order.action==='buy'?[
        `--budget-bnb=${order.budgetBNB}`,`--intent=${row.id}`,...(order.mode==='percent'?[`--percent-bps=${order.bps}`]:[])]:[
        `--sell-bps=${order.bps}`,`--slippage-bps=${settings.slippageBps}`])];
    }else{script='agent_ui/curve_trade.mjs';args=[order.token,'--execute','--manual-confirm',`--action=${order.action}`,`--intent=${row.id}`,
      ...(order.action==='buy'?[`--budget-bnb=${order.budgetBNB}`,...(order.mode==='percent'?[`--percent-bps=${order.bps}`]:[])]:[`--sell-bps=${order.bps}`])];}
    const child=spawn(process.execPath,[join(engine,script),...args],{cwd:ROOT,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.children.set(row.id,child);let buffer='';
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>64_000)buffer=buffer.slice(-64_000);
      while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        try{const event=JSON.parse(line);if(!event.stage)continue;
          event.elapsedMs=Date.now()-Date.parse(row.createdUtc);event.atUtc=new Date().toISOString();row.stage=event.stage;
          row.awaitingApproval=!row.workflowConsent&&/(?:^|_)preview$/.test(event.stage)&&previewRiskState({...event,riskDetails:event.risks})!=='blocked';
          row.events.push(event);row.events=row.events.slice(-40);this.save();}catch{}}
    });child.stderr.resume();
    const close=code=>{row.running=false;row.awaitingApproval=false;row.exitCode=code;
      if(code!==0&&row.stage!=='error')row.stage='interrupted_check_chain';
      this.children.delete(row.id);this.locks.delete(row.walletId);this.save();};
    child.on('error',()=>{row.stage='process_error';close(1);});child.on('close',close);
  }
  async approve(id){const row=this.rows.find(x=>x.id===id);if(!row?.awaitingApproval)throw Error('没有待确认的交易预览');
    if(row.remoteId){await this.pool.request(this.pool.get(row.walletId),'/worker/approve',{jobId:row.remoteId});return;}
    const child=this.children.get(id);if(!child||!row.running)throw Error('订单已结束');
    row.awaitingApproval=false;row.stage='approval_sent';child.stdin.write('APPROVE\n');this.save();
  }
  statistics(){const rows=this.rows.filter(r=>r.events?.length);return {total:rows.length,
    confirmed:rows.filter(r=>r.stage==='confirmed').length,failed:rows.filter(r=>r.stage==='error').length,
    recent:rows.slice(-30).reverse().map(r=>({id:r.id,wallet:r.walletLabel,action:r.action,stage:r.stage,
      elapsedMs:r.events.at(-1)?.elapsedMs||null,steps:r.events.map(e=>({stage:e.stage,elapsedMs:e.elapsedMs}))}))};}
}
