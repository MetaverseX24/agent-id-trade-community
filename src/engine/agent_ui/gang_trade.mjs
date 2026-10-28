import {Contract,formatEther} from 'ethers';
import {GANG,GANG_ABI,GANG_IFACE,GANG_ROUTER_IFACE,GANG_SHARE,fairBuyPlan,gangPoolQuote} from './gang_protocol.mjs';
import {resolveGangBuyQuote} from './gang_curve.mjs';

// Uses the existing queue's submit, allowance, reconciliation and native-settlement machinery.
export async function tradeModernGang(o){
 const {provider,info,plan,state,wallet,abi,wbnb,pancake,minOut,emit,submit,allowance,funded,
  nativeBudget,capacity,prepareSettlement}=o;
 const pad=new Contract(GANG.pad,GANG_ABI,provider),erc=new Contract(info.token,abi.ERC20,provider);
 const same=(a,b)=>a.toLowerCase()===b.toLowerCase(),deadline=()=>BigInt(Math.floor(Date.now()/1000)+240);
 const buy=plan.action==='buy',native=buy?await nativeBudget():0n;
 const held=await erc.balanceOf(wallet),supply=await erc.totalSupply();
 const target=plan.percent===null?supply/100n:supply*plan.percent/10000n,desired=target-held;
 const log=q=>emit({stage:'quote',platform:'gang',kind:info.kind,phase:info.phase,quoteAsset:info.quote,...q});
 const recordNativeFunding=async()=>{state.quoteFunding={asset:wbnb,nativeDirect:true,acquiredRaw:'0',spentRaw:'0'};};
 if(info.phase==='graduated'){
  if(!info.pair)throw Error('external_pool_unverified');
  const dex=new Contract(pancake,abi.PCS_ROUTER,provider);
  const route=same(info.quote,wbnb)?[wbnb,info.token]:[wbnb,info.quote,info.token];
  if(buy){
   if(plan.percent!==null&&desired<=0n)throw Error('gang_target_already_held');
   // Invert the AMM for the desired NET receipt, including the fixed pool buy tax.
   const netTarget=desired>0n?desired:1n,tax=BigInt(info.buyTaxBps||0);
   const grossTarget=(netTarget*10000n+9999n-tax)/(10000n-tax);
   const spend=plan.percent===null?native:(await dex.getAmountsIn(grossTarget,route))[0];
   if(spend>native)throw Error('budget_insufficient_for_target');
   const expected=await gangPoolQuote(provider,info,spend,'buy',{routerAbi:abi.PCS_ROUTER,pancake,wbnb});
   log({grossBNB:formatEther(spend),expectedTokens:formatEther(expected),poolTaxBps:Number(tax)});
   return submit('buy',GANG.router,spend,GANG_ROUTER_IFACE.encodeFunctionData('poolBuyBNB',[info.token,info.quote,minOut(expected),deadline()]));
  }
  const amount=held*plan.sellBps/10000n;if(amount<=0n)throw Error('no_gang_tokens_to_sell');
  if(!await allowance(info.token,GANG.router,amount))return false;
  const expected=await gangPoolQuote(provider,info,amount,'sell',{routerAbi:abi.PCS_ROUTER,pancake,wbnb});
  log({tokensToSell:formatEther(amount),expectedBNB:formatEther(expected),poolTaxBps:info.sellTaxBps});
  state.settlement=await prepareSettlement(true);
  return submit('sell',GANG.router,0n,GANG_ROUTER_IFACE.encodeFunctionData('poolSellForBNB',[info.token,info.quote,amount,minOut(expected),deadline()]));
 }
 if(info.kind==='fair'){
  if(!buy){
   const shares=(await pad.positions(info.token,wallet))*plan.sellBps/10000n;
   if(shares<=0n)throw Error('gang_fair_sell_below_one_share');
   const [expected]=await pad.previewWithdraw(info.token,wallet,shares);
   if(expected<=0n)throw Error('gang_fair_withdraw_unavailable');
   log({tokensToSell:formatEther(shares*GANG_SHARE),shares:String(shares),expectedQuote:String(expected)});
   state.settlement=await prepareSettlement(false);
   // Direct withdraw reclaims locked tokens; there is no ERC-20 approval step.
   return submit('sell',GANG.pad,0n,GANG_IFACE.encodeFunctionData('withdraw',[info.token,shares,minOut(expected)]));
  }
  const quoteBalance=await new Contract(info.quote,abi.ERC20,provider).balanceOf(wallet);
  const upper=same(info.quote,wbnb)?native:await capacity(native,quoteBalance);
  const price=async cap=>{
   const [sale,shares,balance]=await Promise.all([pad.sales(info.token),pad.positions(info.token,wallet),erc.balanceOf(wallet)]);
   if(sale.launched)throw Error('market_migrated_during_funding');
   const q=fairBuyPlan(sale,shares,balance,supply,plan.percent,cap);
   const preview=await pad.previewMint(info.token,wallet,q.shares);
   if(preview.accepted!==q.shares||preview.cost+preview.fee!==q.gross)throw Error('gang_fair_quote_changed');
   return q;
  };
  let q=await price(upper);log({expectedTokens:formatEther(q.output),grossQuote:String(q.gross),shares:String(q.shares)});
  if(same(info.quote,wbnb)){
   await recordNativeFunding();
   return submit('buy',GANG.router,q.gross,GANG_ROUTER_IFACE.encodeFunctionData('fairMintBNB',[info.token,q.shares,q.shares,deadline()]));
  }
  const ready=await funded(q.gross,GANG.pad,price);if(!ready)return false;q=ready;
  // Recompute shares from the exact funded token output; prepareFundedBuy returns gross/output only.
  const shares=q.output/GANG_SHARE;
  return submit('buy',GANG.pad,0n,GANG_IFACE.encodeFunctionData('mint',[info.token,shares,shares]));
 }
 if(!buy){
  const amount=held*plan.sellBps/10000n;if(amount<=0n)throw Error('no_gang_tokens_to_sell');
  if(!await allowance(info.token,GANG.pad,amount))return false;
  const registry=new Contract(GANG.registry,['function previewSell(address,address,uint256) view returns(uint256 quoteOut,uint256 fee)'],provider);
  const [expected]=await registry.previewSell(info.token,wallet,amount);
  if(expected<=0n)throw Error('gang_zero_quote');
  log({tokensToSell:formatEther(amount),expectedQuote:String(expected)});
  state.settlement=await prepareSettlement(false);
  return submit('sell',GANG.pad,0n,GANG_IFACE.encodeFunctionData('sell',[info.token,amount,minOut(expected)]));
 }
 if(desired<=0n)throw Error('gang_target_already_held');
 const quoteBalance=await new Contract(info.quote,abi.ERC20,provider).balanceOf(wallet);
 const upper=same(info.quote,wbnb)?native:await capacity(native,quoteBalance);
 const price=async cap=>{
  const [curve,room,balance]=await Promise.all([pad.curves(info.token),pad.walletRoom(info.token,wallet),erc.balanceOf(wallet)]);
  if(curve.graduated)throw Error('market_migrated_during_funding');
  return resolveGangBuyQuote(curve,cap,target-balance,room,plan.percent!==null);
 };
 let q=await price(upper);
 log({grossQuote:String(q.gross),expectedTokens:formatEther(q.output)});
 if(same(info.quote,wbnb)){
  await recordNativeFunding();
  return submit('buy',GANG.router,q.gross,GANG_ROUTER_IFACE.encodeFunctionData('v3BuyBNB',[info.token,minOut(q.output),deadline()]));
 }
 const ready=await funded(q.gross,GANG.pad,price);if(!ready)return false;q=ready;
 return submit('buy',GANG.pad,0n,GANG_IFACE.encodeFunctionData('buy',[info.token,q.gross,minOut(q.output)]));
}
