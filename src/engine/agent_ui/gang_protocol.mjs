import {Contract,Interface,ZeroAddress,getAddress} from 'ethers';
export const GANG=Object.freeze({
  pad:getAddress('0x15CFD2dc8278Fb87a1783ef42111618E20874365'),
  router:getAddress('0xE040445690Aa56C8b68B7f7038C7b2562B5079C4'),
  registry:getAddress('0x4fF77D4d9ac080939a24E1B805206bA094C44e5C'),
  handler:getAddress('0x6D8d3dE459629cBb7b552169a55D754db60cAe0c'),
  safe:getAddress('0x2866369F7acEFC9760bdE7779362fae5cD68B41E'),
  timelock:getAddress('0x3911996E2F6c5636d6b1b32f75cf94d0aF4604C5'),
});
export const GANG_ABI=[
 'function kindOf(address) view returns(uint8)',
 'function curves(address) view returns(address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,uint16 buyTaxBps,uint16 sellTaxBps,uint16 dividendBps,address pair,address refPair)',
 'function sales(address) view returns(address creator,uint64 progressAt,uint16 capShares,uint16 holdBps,address quote,uint16 sold,bool launched,uint16 mintFeeBps,uint16 exitFeeBps,address gate,uint128 sharePrice,address pair,address refPool,uint16 markSold)',
 'function positions(address,address) view returns(uint16 shares)',
 'function walletRoom(address,address) view returns(uint256)',
 'function buy(address,uint256,uint256) returns(uint256)',
 'function sell(address,uint256,uint256) returns(uint256)',
 'function mint(address,uint256,uint256) returns(uint256)',
 'function withdraw(address,uint256,uint256) returns(uint256)',
 'function previewMint(address,address,uint256) view returns(uint256 accepted,uint256 cost,uint256 fee)',
 'function previewWithdraw(address,address,uint256) view returns(uint256 payout,uint256 fee)',
 'function routers(address) view returns(bool)',
 'function taxHandler() view returns(address)',
 'function owner() view returns(address)',
 'function agentGateEnabled() view returns(bool)',
 'function walletCapEnabled() view returns(bool)',
];
export const GANG_REGISTRY_ABI=[
 'function lookup(address) view returns(address pad,uint8 kind)',
 'function previewBuy(address,address,uint256) view returns(uint256 tokensOut,uint256 spent,uint256 fee,uint256 refund)',
 'function previewSell(address,address,uint256) view returns(uint256 quoteOut,uint256 fee)',
 'function owner() view returns(address)',
];
export const GANG_ROUTER_ABI=[
 'function pad() view returns(address)','function wbnb() view returns(address)','function pancakeRouter() view returns(address)',
 'function v3BuyBNB(address,uint256,uint256) payable returns(uint256)',
 'function fairMintBNB(address,uint256,uint256,uint256) payable returns(uint256)',
 'function poolBuyBNB(address,address,uint256,uint256) payable returns(uint256)',
 'function poolSellForBNB(address,address,uint256,uint256,uint256) returns(uint256)',
];
export const GANG_IFACE=new Interface(GANG_ABI),GANG_ROUTER_IFACE=new Interface(GANG_ROUTER_ABI);
export const GANG_SHARE=50000n*10n**18n;
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();

export function checkGangTradeCall(context,consent){
 if(!consent.gangKind||!['buy','sell'].includes(context.step))return;
 const onRouter=same(context.to,GANG.router),i=onRouter?GANG_ROUTER_IFACE:GANG_IFACE;
 let d;try{d=i.parseTransaction({data:context.inputData});}catch{throw Error('gang_workflow_calldata_invalid');}
 const allowed=context.step==='buy'?(consent.gangPhase==='graduated'?['poolBuyBNB']:consent.gangKind==='fair'?['fairMintBNB','mint']:['v3BuyBNB','buy']):
  (consent.gangPhase==='graduated'?['poolSellForBNB']:consent.gangKind==='fair'?['withdraw']:['sell']);
 if(!d||!allowed.includes(d.name)||!same(d.args[0],consent.token))throw Error('gang_workflow_trade_mismatch');
 if(d.name.startsWith('pool')&&!same(d.args[1],consent.quoteAsset))throw Error('gang_workflow_quote_mismatch');
 const native=BigInt(context.valueWei||0),expectsNative=['poolBuyBNB','v3BuyBNB','fairMintBNB'].includes(d.name);
 if(expectsNative?native<=0n:native!==0n)throw Error('gang_workflow_value_mismatch');
 if(onRouter){const expiry=d.args.at(-1),now=BigInt(Math.floor(Date.now()/1000));
  if(expiry<now||expiry>now+600n)throw Error('gang_workflow_deadline_invalid');}
 const minimum=d.args[onRouter?d.args.length-2:2];
 if(minimum<=0n)throw Error('gang_workflow_minimum_invalid');
}

// Registry lookup cross-checks launchpad() AND pad.kindOf(): a copied name or pointer is insufficient.
export async function detectModernGang(provider,token,wallet,{ercAbi,wbnb,verifiedPair}){
 const registry=new Contract(GANG.registry,GANG_REGISTRY_ABI,provider);
 const found=await registry.lookup(token); // RPC failures are not an unknown token.
 if(same(found.pad,ZeroAddress))return null;
 if(!same(found.pad,GANG.pad))throw Error('gang_pad_update_requires_review');
 const p=new Contract(GANG.pad,GANG_ABI,provider),erc=new Contract(token,ercAbi,provider);
 const kind=Number(found.kind);
 if(![1,2].includes(kind))throw Error('gang_unknown_token_kind');
 const [entry,held,supply,locked,pointer]=await Promise.all([
  kind===1?p.curves(token):p.sales(token),erc.balanceOf(wallet),erc.totalSupply(),erc.locked(),
  new Contract(token,['function launchpad() view returns(address)'],provider).launchpad(),
 ]);
 if(same(entry.creator,ZeroAddress)||!same(pointer,GANG.pad))throw Error('gang_registration_mismatch');
 const launched=kind===1?entry.graduated:entry.launched;
 if(locked===launched)throw Error('gang_migration_state_inconsistent');
 const info={platform:'gang',label:kind===1?'Gang.fun V3 Agent':'Gang.fun 公平打新',token,
  phase:launched?'graduated':'curve',quote:getAddress(entry.quote),venue:GANG.pad,
  pad:'gang',kind:kind===1?'v3':'fair',held,supply,buyTaxBps:kind===1?Number(entry.buyTaxBps):100,
  sellTaxBps:kind===1?Number(entry.sellTaxBps):100,curve:kind===1?entry:null,sale:kind===2?entry:null};
 if(kind===2){info.heldShares=await p.positions(token,wallet);info.cap=BigInt(entry.capShares)*GANG_SHARE;
  info.maxBuyPercent=launched?1:Number(BigInt(entry.capShares)*GANG_SHARE*10000n/supply)/100;}
 if(launched){const actual=await verifiedPair(provider,token,info.quote);
  if(actual&&same(actual,entry.pair))info.pair=actual;}
 return info;
}

export function fairBuyPlan(sale,heldShares,heldTokens,supply,percent,capacity){
 const room=BigInt(sale.capShares)-BigInt(heldShares),left=10000n-BigInt(sale.sold);
 const max=room<left?room:left;
 if(max<=0n)throw Error('gang_wallet_cap_reached');
 let shares;
 if(percent!==null){const desired=BigInt(supply)*BigInt(percent)/10000n-BigInt(heldTokens);
  if(desired<=0n)throw Error('gang_target_already_held');
  shares=(desired+GANG_SHARE-1n)/GANG_SHARE;
  if(shares*GANG_SHARE!==desired)throw Error('gang_fair_target_requires_whole_shares');
  if(shares>max)throw Error('gang_fair_target_exceeds_cap_or_remaining');
 }else{
  shares=BigInt(capacity)*10000n/(BigInt(sale.sharePrice)*(10000n+BigInt(sale.mintFeeBps)));
  if(shares>max)shares=max;
 }
 if(shares<=0n)throw Error('gang_fair_budget_below_one_share');
 const cost=shares*BigInt(sale.sharePrice),gross=cost+cost*BigInt(sale.mintFeeBps)/10000n;
 if(gross>BigInt(capacity))throw Error('budget_insufficient_for_target');
 return {shares,gross,output:shares*GANG_SHARE};
}

// New taxed tokens quote the next-block swap-back and sell tax, not just raw AMM reserves.
export async function gangPoolQuote(provider,info,amount,side,{routerAbi,pancake,wbnb}){
 const router=new Contract(pancake,routerAbi,provider),tax=BigInt(side==='buy'?info.buyTaxBps:info.sellTaxBps);
 if(side==='sell'&&['v3','fair'].includes(info.kind)&&tax>0n){
  const handler=new Contract(GANG.handler,['function previewSellNextBlock(address,uint256) view returns(uint256 quoteOut,uint256 chunk)'],provider);
  const [quote]=await handler.previewSellNextBlock(info.token,amount);
  if(quote<=0n)throw Error('gang_tax_sell_quote_unavailable');
  if(same(info.quote,wbnb))return quote;
  return (await router.getAmountsOut(quote,[info.quote,wbnb])).at(-1);
 }
 const path=same(info.quote,wbnb)?[wbnb,info.token]:[wbnb,info.quote,info.token];
 if(side==='sell')path.reverse();
 const out=(await router.getAmountsOut(amount,path)).at(-1);
 return side==='buy'?out-out*tax/10000n:out;
}
