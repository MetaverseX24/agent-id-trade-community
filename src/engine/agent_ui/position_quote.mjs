import {readFileSync} from 'node:fs';
import {Contract,ZeroAddress,getAddress} from 'ethers';
import {ABI,WBNB,BNB,FLAP,GANG_PADS} from './platforms.mjs';
import {gangV2SellQuote} from './gang_curve.mjs';
import {GANG,GANG_ABI,GANG_REGISTRY_ABI,GANG_SHARE,gangPoolQuote} from './gang_protocol.mjs';
import {ROUTER} from './platforms.mjs';
import {quotePaths,bestPathQuote} from './quote_paths.mjs';
const toolsAbi=JSON.parse(readFileSync(new URL('../abi/OpenFourTools.json',import.meta.url),'utf8'));
const native=a=>!a||[ZeroAddress,WBNB,BNB].some(x=>x.toLowerCase()===String(a).toLowerCase());
export async function convertQuote(provider,from,to,amount){amount=BigInt(amount);if(amount===0n)return 0n;
  from=native(from)?WBNB:getAddress(from);to=native(to)?WBNB:getAddress(to);if(from===to)return amount;
  let bnb=amount;if(from!==WBNB)bnb=(await bestPathQuote(provider,(await quotePaths(provider,from)).map(p=>[...p].reverse()),amount)).amount;
  return to===WBNB?bnb:(await bestPathQuote(provider,await quotePaths(provider,to),bnb)).amount;
}
export async function positionBalance(provider,info,wallet){
  if(info.platform==='flap'&&info.phase==='curve')return new Contract(info.market,ABI.FLAP_MARKET,provider).sharesOf(wallet);
  return new Contract(info.token,ABI.ERC20,provider).balanceOf(wallet);
}
export async function positionQuote(provider,info,{bps=10000,address:wallet}){
  const held=await positionBalance(provider,info,wallet),amount=held*BigInt(bps)/10000n;
  if(amount<=0n)throw Error('no_position_for_quote');let quote=info.quote,output,mode='exact_sell_quote';
  if(info.platform==='four'&&info.phase==='curve'){
    const registry=new Contract('0x912CEf0C3aE9Ab6eB3Ec87cab69371cFb317Ab94',['function openFourTool() view returns(address)'],provider);
    const estimate=await new Contract(await registry.openFourTool(),toolsAbi,provider).estimateSell.staticCall(info.token,wallet,amount,native(quote)?0n:2n,'0x');
    output=estimate.userReceives;quote=WBNB;
  }else if(info.platform==='gang'&&info.phase==='curve'){
    if(info.kind==='fair'){
      const c=new Contract(GANG.pad,GANG_ABI,provider),heldShares=await c.positions(info.token,wallet);
      let shares=heldShares*BigInt(bps)/10000n;
      if(shares===0n&&bps===1&&heldShares>0n)shares=1n; // Unit-price probe, not a sell order.
      if(shares<=0n)throw Error('gang_fair_sell_below_one_share');
      output=(await c.previewWithdraw(info.token,wallet,shares))[0];
      return {inputRaw:String(shares*GANG_SHARE),outputRaw:String(output),quoteAsset:quote,mode:'fair_withdraw_quote'};
    }
    if(info.kind==='v3')output=(await new Contract(GANG.registry,GANG_REGISTRY_ABI,provider).previewSell(info.token,wallet,amount))[0];
    else {const pad=GANG_PADS.find(x=>x.id===info.pad),c=new Contract(pad.address,pad.kind==='soft'?ABI.GANG_SOFT:pad.id==='s'?ABI.GANG_S:ABI.GANG_V2,provider);
    output=pad.kind==='soft'?(await c.quoteSell(info.token,amount))[0]:gangV2SellQuote(await c.curves(info.token),amount);}
  }else if(info.platform==='flap'&&info.phase==='curve'){
    output=(await new Contract(FLAP.portal,ABI.FLAP_PORTAL,provider).quoteSellAll(info.market,wallet))[3]*BigInt(bps)/10000n;
    mode='proportional_full_sale_quote';
  }else if(info.platform==='flap'&&['standard_curve','graduated'].includes(info.phase)){
    const c=new Contract(FLAP.standardPortal,ABI.FLAP_STANDARD,provider);
    try{output=await c.quoteExactInput.staticCall([info.token,ZeroAddress,amount]);quote=WBNB;}
    catch{output=await c.quoteExactInput.staticCall([info.token,quote,amount]);}
  }else if(info.platform==='gang'&&['v3','fair'].includes(info.kind)&&info.pair){
    output=await gangPoolQuote(provider,info,amount,'sell',{routerAbi:ABI.PCS_ROUTER,pancake:ROUTER,wbnb:WBNB});quote=WBNB;
  }else if(info.pair){
    const paths=(await quotePaths(provider,native(quote)?WBNB:quote)).map(p=>[info.token,...[...p].reverse()]);
    output=(await bestPathQuote(provider,paths,amount)).amount;quote=WBNB;
  }else throw Error('position_quote_route_unavailable');
  if(output<=0n)throw Error('position_quote_zero');
  return {inputRaw:String(amount),outputRaw:String(output),quoteAsset:native(quote)?WBNB:quote,mode};
}
