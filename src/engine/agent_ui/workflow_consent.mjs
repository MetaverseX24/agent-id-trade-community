import { getAddress, parseEther,Interface,ZeroAddress } from 'ethers';
import { FOUR_CORE, FLAP, GANG_PADS, ROUTER, WBNB } from './platforms.mjs';
import { previewRiskState } from '../preview_policy.mjs';
import {GANG,checkGangTradeCall} from './gang_protocol.mjs';

const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
export function makeWorkflowConsent(info,order,wallet,id){
  const protocol=info.platform==='four'?[FOUR_CORE]:info.platform==='flap'?[FLAP.portal,FLAP.standardPortal,...(info.market?[info.market]:[])]:
    (info.pad==='gang'?[GANG.pad,GANG.router]:[GANG_PADS.find(x=>x.id===info.pad)?.address]).filter(Boolean);
  const gang=info.pad==='gang'?{gangKind:info.kind,gangPhase:info.phase}:{};
  const assets=[info.token,info.quote,WBNB].filter(x=>x&& !/^0x0+$/.test(x));
  return {id,chainId:56,...gang,wallet:getAddress(wallet),token:info.token,action:order.action,
    quoteAsset:!info.quote||same(info.quote,ZeroAddress)||same(info.quote,'0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')?WBNB:info.quote,
    maxNativeWei:order.action==='buy'?parseEther(order.budgetBNB||'0.3').toString():'0',
    targets:[...new Set([...assets,...protocol,ROUTER])],spenders:[...protocol,ROUTER],assets};
}
export function checkWorkflowStep(preview,context,consent,spent=0n){
  if(!consent||!/^[0-9a-f-]{36}$/i.test(consent.id||'')||consent.chainId!==56||
      !same(context?.from,consent.wallet)||!consent.targets.some(x=>same(x,context.to)))
    throw Error('workflow_scope_mismatch');
  if(previewRiskState(preview)==='blocked')throw Error('workflow_preview_blocked');
  if(preview.parsedTx?.contractAddress&&!same(preview.parsedTx.contractAddress,context.to))throw Error('workflow_preview_target_mismatch');
  if(!['buy','sell','approve','approval','wrap','get_quote','claim','unwrap','sell_quote'].includes(context.step))throw Error('workflow_step_not_authorized');
  if(['buy','sell'].includes(context.step)&&context.step!==consent.action)throw Error('workflow_action_mismatch');
  if(['buy','sell'].includes(context.step)&&!consent.spenders.some(x=>same(x,context.to)))throw Error('workflow_trade_target_mismatch');
  checkGangTradeCall(context,consent);
  const value=BigInt(context.valueWei||0),cap=BigInt(consent.maxNativeWei);
  if(value<0n||spent+value>cap)throw Error('workflow_native_budget_exceeded');
  if(['approve','approval'].includes(context.step)){
    if(value!==0n||!consent.assets.some(x=>same(x,context.to))||!/^0x095ea7b3[0-9a-f]{128}$/i.test(context.inputData||''))
      throw Error('workflow_approval_mismatch');
    const spender='0x'+context.inputData.slice(34,74),amount=BigInt('0x'+context.inputData.slice(74));
    if(!consent.spenders.some(x=>same(x,spender))||amount<=0n||amount>=2n**255n)throw Error('workflow_spender_or_allowance_rejected');
  }
  if(context.step==='wrap'&&(!same(context.to,WBNB)||context.inputData!=='0xd0e30db0'||value<=0n))throw Error('workflow_wrap_mismatch');
  if(context.step==='get_quote'&&(!same(context.to,ROUTER)||consent.action!=='buy'))throw Error('workflow_quote_swap_mismatch');
  if(context.step==='claim'&&(!same(context.to,FLAP.portal)||value!==0n))throw Error('workflow_claim_mismatch');
  if(['unwrap','sell_quote'].includes(context.step)){
    if((consent.action!=='sell'&&!(consent.action==='buy'&&context.settlementKind==='buy_surplus'))||value!==0n||
      !/^0x[0-9a-f]{64}$/i.test(context.proceedsTxHash||''))throw Error('workflow_settlement_proof_missing');
    const cap=BigInt(context.proceedsWei||0);let amount;
    if(context.step==='unwrap'){
      if(!same(context.to,WBNB)||!/^0x2e1a7d4d[0-9a-f]{64}$/i.test(context.inputData||''))throw Error('workflow_unwrap_mismatch');
      amount=BigInt('0x'+context.inputData.slice(10));
    }else{
      if(!same(context.to,ROUTER))throw Error('workflow_settlement_target_mismatch');
      const decoded=new Interface(['function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)'])
        .decodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens',context.inputData);
      amount=decoded[0];const path=decoded[2];
      if(!same(decoded[3],consent.wallet)||!same(path[0],consent.quoteAsset)||!same(path.at(-1),WBNB)||decoded[1]<=0n)
        throw Error('workflow_settlement_route_mismatch');
    }
    if(amount<=0n||amount>cap)throw Error('workflow_settlement_amount_exceeded');
  }
  return spent+value;
}
