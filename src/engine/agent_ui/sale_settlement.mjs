import {Contract,Interface,ZeroAddress,formatEther,formatUnits,parseEther,getAddress} from 'ethers';
import {ABI,WBNB,BNB} from './platforms.mjs';
import {baw} from '../wallet_cli.mjs';
import {assertSettlementPins} from './protocol_pins.mjs';
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const ercEvents=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const wrapped=new Interface(['function withdraw(uint256)','event Withdrawal(address indexed src,uint256 wad)']);

export function netReceived(receipt,asset,wallet){let amount=0n;
  for(const log of receipt.logs||[]){if(!same(log.address,asset))continue;
    try{const a=ercEvents.parseLog(log).args;if(same(a.to,wallet))amount+=a.value;if(same(a.from,wallet))amount-=a.value;}catch{}}
  return amount;
}
export const receivedInReceipt=(receipt,asset,wallet)=>{const n=netReceived(receipt,asset,wallet);return n>0n?n:0n;};
export function proceedsToConvert(received,before,current){const delta=BigInt(current)-BigInt(before);
  const amount=BigInt(received);return delta>0n?(delta<amount?delta:amount):0n;}
export async function prepareSaleSettlement(provider,info,wallet,nativeExpected=false){
  const quote=nativeExpected||same(info.quote,ZeroAddress)||same(info.quote,'0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')?WBNB:getAddress(info.quote);
  const balance=await new Contract(quote,ABI.ERC20,provider).balanceOf(wallet);
  if(same(quote,WBNB))await assertSettlementPins(provider,false);
  return {asset:quote,wallet:getAddress(wallet),beforeBalance:balance.toString(),nativeExpected};
}
export function recordSaleReceipt(state,receipt,wallet){if(!state.settlement)return;
  state.settlement.saleTxHash=receipt.hash||receipt.transactionHash;
  state.settlement.receivedRaw=receivedInReceipt(receipt,state.settlement.asset,wallet).toString();
}
export function recordNativeReceipt(state,receipt,label){if(label!=='unwrap'||!state.settlement)return;
  let native=0n;for(const log of receipt.logs||[]){if(!same(log.address,WBNB))continue;
    try{const a=wrapped.parseLog(log).args;if(same(a.src,state.settlement.wallet))native+=a.wad;}catch{}}
  if(native<=0n)throw Error('native_settlement_withdrawal_proof_missing');
  state.settlement.nativeSettled=true;state.settlement.nativeReceivedWei=native.toString();
}
// Persist before submitting; an unknown result must never submit a second swap.
export async function marketConvertToNative({provider,wallet,state,amount,slippageBps,persist,emit,cli=baw,
  sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=300000}){
  const s=state.settlement,asset=s.asset;
  if(!/^0x[0-9a-f]{64}$/i.test(s.saleTxHash||'')||BigInt(amount)<=0n||BigInt(amount)>BigInt(s.receivedRaw||0))
    throw Error('native_conversion_proceeds_scope_invalid');
  if(process.env.AGENT_WORKFLOW_CONSENT){const scope=JSON.parse(process.env.AGENT_WORKFLOW_CONSENT);
    if(!same(scope.wallet,wallet)||!same(scope.quoteAsset,asset)||
      (scope.action!=='sell'&&!(scope.action==='buy'&&s.kind==='buy_surplus')))
      throw Error('native_conversion_workflow_scope_invalid');}
  const decimals=Number(await new Contract(asset,ABI.ERC20,provider).decimals());
  const qty=formatUnits(amount,decimals);
  if(!s.nativeOrder){
    s.nativeOrder={stage:'submitting',asset,amountRaw:String(amount),mev:true,slippageBps:Number(slippageBps)};persist();
    try{
      const result=await cli(['market-order','swap','--fromTokenQty',qty,'--fromToken',asset,'--toToken',BNB,
        '--binanceChainId','56','--slippage',String(Number(slippageBps)/100),'--mev','true','--gasLevel','MEDIUM'],60000);
      if(!result.orderId)throw Error('native_swap_order_id_missing');
      s.nativeOrder.orderId=String(result.orderId);s.nativeOrder.stage='pending';persist();
    }catch{ s.nativeOrder.stage='submission_unknown';persist();emit({stage:'native_conversion_submission_unknown'});return false; }
  }
  const n=s.nativeOrder;
  if(n.amountRaw!==String(amount)||!same(n.asset,asset))throw Error('native_conversion_scope_changed');
  if(!n.orderId){emit({stage:'native_conversion_submission_unknown'});return false;}
  for(const deadline=Date.now()+timeoutMs;Date.now()<deadline;){
    let result;try{result=await cli(['market-order','list','--orderId',n.orderId]);}catch{await sleep(1000);continue;}
    const order=result.list?.find(o=>String(o.orderId)===n.orderId);
    if(!order){await sleep(700);continue;}
    n.stage=order.status;n.txHash=order.txHash||null;persist();
    if(order.status==='FAILED'){emit({stage:'native_conversion_failed',orderId:n.orderId});return false;}
    if(order.status!=='FINISHED'){await sleep(700);continue;}
    if(!same(order.fromToken,asset)||!same(order.toToken,BNB)||String(order.chain)!=='56'||
      !/^0x[0-9a-f]{64}$/i.test(order.txHash||''))throw Error('native_conversion_order_mismatch');
    const [tx,receipt]=await Promise.all([provider.getTransaction(order.txHash),provider.getTransactionReceipt(order.txHash)]);
    if(!tx||!receipt){await sleep(700);continue;}
    if(receipt.status!==1||!same(tx.from,wallet))throw Error('native_conversion_receipt_invalid');
    const spent=-netReceived(receipt,asset,wallet);
    n.spentRaw=spent.toString();persist();
    if(spent!==BigInt(amount)){
      n.stage='partial_fill_review_required';persist();emit({stage:'native_conversion_partial_fill',orderId:n.orderId});return false;
    }
    const actual=parseEther(String(order.toTokenActualQty||'0'));
    if(actual<=0n)throw Error('native_conversion_output_unconfirmed');
    s.nativeSettled=true;s.nativeReceivedWei=actual.toString();n.stage='confirmed';persist();
    emit({stage:'native_conversion_confirmed',txHash:order.txHash,receivedBNB:formatEther(actual),mev:true});return true;
  }
  emit({stage:'native_conversion_pending',orderId:n.orderId});return false;
}
export async function settleSaleToBNB({provider,wallet,state,slippageBps,submit,persist,emit}){
  const s=state.settlement;if(!s?.saleTxHash)throw Error('sale_settlement_proof_missing');
  if(s.nativeSettled)return true;
  if(s.nativeOrder)return marketConvertToNative({provider,wallet,state,amount:BigInt(s.nativeOrder.amountRaw),slippageBps,persist,emit});
  const received=BigInt(s.receivedRaw||'0');
  if(received===0n){if(!s.nativeExpected)throw Error('sale_quote_receipt_missing');
    s.nativeSettled=true;persist();emit({stage:'native_settlement_complete',asset:'BNB',alreadyNative:true});return true;}
  const current=await new Contract(s.asset,ABI.ERC20,provider).balanceOf(wallet);
  const amount=proceedsToConvert(received,s.beforeBalance,current);
  if(amount<=0n)throw Error('sale_quote_proceeds_unavailable');
  s.amountRaw=amount.toString();persist();
  if(same(s.asset,WBNB)){
    await assertSettlementPins(provider,false);
    emit({stage:'unwrap_required',amountBNB:formatEther(amount)});
    if(!await submit('unwrap',WBNB,wrapped.encodeFunctionData('withdraw',[amount])))return false;
  }else{
    if(!await marketConvertToNative({provider,wallet,state,amount,slippageBps,persist,emit}))return false;
  }
  if(!s.nativeSettled)throw Error('native_settlement_receipt_missing');
  persist();emit({stage:'native_settlement_complete',asset:'BNB',nativeReceivedBNB:formatEther(s.nativeReceivedWei||0)});return true;
}

export function recordBuyFundingReceipt(state,receipt,wallet){const f=state.quoteFunding;if(!f)return;
  f.buyTxHash=receipt.hash||receipt.transactionHash;
  if(f.nativeDirect){const refund=netReceived(receipt,f.asset,wallet);f.acquiredRaw=String(refund>0n?refund:0n);f.spentRaw='0';return;}
  const spent=-netReceived(receipt,f.asset,wallet);f.spentRaw=(spent>0n?spent:0n).toString();
}
export function unusedAcquiredQuote(f){const unused=BigInt(f.acquiredRaw||0)-BigInt(f.spentRaw||0);return unused>0n?unused:0n;}
export async function settleBuySurplus(options){const {provider,wallet,state,persist,emit}=options,f=state.quoteFunding;
  if(state.settlement?.kind==='buy_surplus')return settleSaleToBNB(options);
  if(!f?.buyTxHash)return true;
  const unused=unusedAcquiredQuote(f);if(unused===0n)return true;
  const current=await new Contract(f.asset,ABI.ERC20,provider).balanceOf(wallet);
  if(current<unused)throw Error('buy_surplus_balance_changed');
  state.settlement={asset:f.asset,wallet:getAddress(wallet),saleTxHash:f.buyTxHash,receivedRaw:String(unused),
    beforeBalance:String(current-unused),nativeExpected:false,kind:'buy_surplus'};
  persist();emit({stage:'buy_surplus_returning_to_bnb',quoteAsset:f.asset,amountRaw:String(unused)});
  return settleSaleToBNB(options);
}
