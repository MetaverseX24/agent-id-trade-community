import { Contract, ZeroAddress, formatEther, formatUnits, parseEther, getAddress } from 'ethers';
import { ABI, FLAP, WBNB, ROUTER } from './engine/agent_ui/platforms.mjs';
import { quotePaths, bestPathQuote } from './engine/agent_ui/quote_paths.mjs';
import { resolveBuyQuote } from './engine/agent_ui/quote_search.mjs';
import {resolveGangBuyQuote} from './engine/agent_ui/gang_curve.mjs';
import {GANG,GANG_ABI,GANG_REGISTRY_ABI,GANG_SHARE,fairBuyPlan,gangPoolQuote} from './engine/agent_ui/gang_protocol.mjs';
import { REGISTRY, toolsAbi } from './protocol_snapshot.mjs';
const VT=1066666666666666666666666667n,ceil=(a,b)=>(a+b-1n)/b;
export function gangBuy(c,gross,room){const reserve=VT-c.sold;if(reserve<=0n)return 0n;
  let net=gross-gross/100n;const left=c.gradAmt-c.realQuote;if(net>left)net=left;if(net<=0n)return 0n;
  let out=reserve-ceil(c.virtualQuote*VT,c.virtualQuote+c.realQuote+net);return room!==null&&out>room?room:out;}
export function gangSell(c,amount){const reserve=VT-c.sold;if(reserve<=0n)return 0n;
  const out=c.virtualQuote+c.realQuote-ceil(c.virtualQuote*VT,reserve+amount);return out-out/100n;}
export async function quoteAsBNB(provider,asset,amount){if(asset===ZeroAddress||getAddress(asset)===WBNB)return amount;
  return (await bestPathQuote(provider,(await quotePaths(provider,asset)).map(p=>[...p].reverse()),amount)).amount;}
export async function createQuote(provider,info,order){
  const address=order.address||ZeroAddress,bps=BigInt(order.bps||100),buy=order.action==='buy';
  const token=new Contract(info.token,ABI.ERC20,provider);
  const [supply,held,decimals]=await Promise.all([token.totalSupply().catch(()=>0n),token.balanceOf(address).catch(()=>0n),token.decimals().catch(()=>18n)]);
  const native=parseEther(String(order.budgetBNB||'0.3'));
  const quantity=buy?(supply*bps/10000n-held):held*bps/10000n;
  let expected=0n,input=0n,quote=info.quote,unit='token';
  if(info.platform==='four'&&info.phase==='curve'){
    const registry=new Contract(REGISTRY,['function openFourTool() view returns(address)'],provider);
    const tools=new Contract(await registry.openFourTool(),toolsAbi,provider),options=quote===WBNB?0n:2n;
    const estimate=buy?(order.mode==='bnb'?await tools.estimateBuyByBudget.staticCall(info.token,address,native,options,'0x'):
      await tools.estimateBuy.staticCall(info.token,address,quantity,options,'0x')):
      await tools.estimateSell.staticCall(info.token,address,quantity,options,'0x');
    if(buy){input=estimate.userPays;expected=estimate.tokenAmount;}else{input=quantity;expected=estimate.userReceives;}quote=WBNB;
  }else if(info.platform==='gang'&&['v3','fair'].includes(info.kind)&&info.phase==='curve'){
    const pad=new Contract(GANG.pad,GANG_ABI,provider);
    if(info.kind==='fair'){
      const [sale,shares]=await Promise.all([pad.sales(info.token),pad.positions(info.token,address)]);
      if(buy){let upper=native;if(quote!==WBNB)upper=(await bestPathQuote(provider,await quotePaths(provider,quote),native*98n/100n)).amount;
        const result=fairBuyPlan(sale,shares,held,supply,order.mode==='bnb'?null:bps,upper);
        input=result.gross;expected=result.output;
      }else{const n=shares*bps/10000n;input=n*GANG_SHARE;expected=(await pad.previewWithdraw(info.token,address,n))[0];}
    }else{
      const [c,room]=await Promise.all([pad.curves(info.token),pad.walletRoom(info.token,address)]);
      if(buy){let upper=native;if(quote!==WBNB)upper=(await bestPathQuote(provider,await quotePaths(provider,quote),native*98n/100n)).amount;
        const result=resolveGangBuyQuote(c,upper,quantity,room,order.mode!=='bnb');input=result.gross;expected=result.output;
      }else{input=quantity;expected=(await new Contract(GANG.registry,GANG_REGISTRY_ABI,provider).previewSell(info.token,address,quantity))[0];}
    }
  }else if(info.platform==='gang'&&['v3','fair'].includes(info.kind)&&info.pair){
    if(buy){const path=quote===WBNB?[WBNB,info.token]:[WBNB,quote,info.token];
      const tax=BigInt(info.buyTaxBps||0),gross=(quantity*10000n+9999n-tax)/(10000n-tax);
      input=order.mode==='bnb'?native:(await new Contract(ROUTER,ABI.PCS_ROUTER,provider).getAmountsIn(gross,path))[0];
      expected=await gangPoolQuote(provider,info,input,'buy',{routerAbi:ABI.PCS_ROUTER,pancake:ROUTER,wbnb:WBNB});
    }else{input=quantity;expected=await gangPoolQuote(provider,info,input,'sell',{routerAbi:ABI.PCS_ROUTER,pancake:ROUTER,wbnb:WBNB});}quote=WBNB;
  }else if(info.platform==='gang'&&info.phase==='curve'){
    const pad=new Contract(info.venue,info.kind==='soft'?ABI.GANG_SOFT:info.pad==='s'?ABI.GANG_S:ABI.GANG_V2,provider);
    if(info.kind==='soft'){
      if(buy){const result=await resolveBuyQuote(native,quantity,async x=>(await pad.quoteBuy(info.token,address,x))[0],order.mode!=='bnb');input=result.gross;expected=result.output;}
      else{input=quantity;expected=(await pad.quoteSell(info.token,quantity))[0];}
    }else{const [c,room]=await Promise.all([pad.curves(info.token),pad.walletRoom(info.token,address)]);
      if(buy){let upper=native;if(quote!==WBNB)upper=(await bestPathQuote(provider,await quotePaths(provider,quote),native*98n/100n)).amount;
        const result=resolveGangBuyQuote(c,upper,quantity,room,order.mode!=='bnb');input=result.gross;expected=result.output;}
      else{input=quantity;expected=gangSell(c,quantity);}}
  }else if(info.platform==='flap'&&info.phase==='curve'){
    const market=new Contract(info.market,ABI.FLAP_MARKET,provider),portal=new Contract(FLAP.portal,ABI.FLAP_PORTAL,provider);
    const [cap,shares]=await Promise.all([market.maxSharesPerWallet(),market.sharesOf(address)]);unit='shares';
    if(buy){const target=cap*bps/200n*9995n/10000n-shares;let upper=native;
      if(quote!==ZeroAddress&&quote!==WBNB)upper=(await bestPathQuote(provider,await quotePaths(provider,quote),native*98n/100n)).amount;
      const result=await resolveBuyQuote(upper,target,async x=>(await portal.quoteBuy(info.market,address,x))[3],order.mode!=='bnb');input=result.gross;expected=result.output;
    }else{input=shares*bps/10000n;expected=(await portal.quoteSellAll(info.market,address))[3]*bps/10000n;}
  }else if(info.platform==='flap'&&['standard_curve','graduated'].includes(info.phase)){
    const portal=new Contract(FLAP.standardPortal,ABI.FLAP_STANDARD,provider),nativeInput=quote===WBNB||info.nativeToQuoteSwapEnabled;
    if(buy){let upper=native;if(!nativeInput)upper=(await bestPathQuote(provider,await quotePaths(provider,quote),native*98n/100n)).amount;
      const q=async amount=>portal.quoteExactInput.staticCall([nativeInput?ZeroAddress:quote,info.token,amount]);
      const result=await resolveBuyQuote(upper,quantity,q,order.mode!=='bnb');input=result.gross;expected=result.output;if(nativeInput)quote=WBNB;
    }else{input=quantity;expected=await portal.quoteExactInput.staticCall([info.token,quote===WBNB?ZeroAddress:quote,quantity]);}
  }else if(info.pair){
    const prefixes=await quotePaths(provider,quote);const paths=prefixes.map(p=>[...p,info.token]);
    if(buy){const result=order.mode==='bnb'?await bestPathQuote(provider,paths,native):await bestPathQuote(provider,paths,quantity,true);
      input=order.mode==='bnb'?native:result.amount;expected=order.mode==='bnb'?result.amount:quantity;quote=WBNB;
    }else{input=quantity;expected=(await bestPathQuote(provider,paths.map(p=>[...p].reverse()),quantity)).amount;quote=WBNB;}
  }else throw Error('当前交易路径未验证');
  if(input<=0n||expected<=0n)throw Error(buy?'目标持仓已达到或报价为空':'当前钱包没有可卖持仓');
  const quoteDecimals=quote===WBNB||quote===ZeroAddress?18:Number(await new Contract(quote,ABI.ERC20,provider).decimals());
  const nativeValue=await quoteAsBNB(provider,quote,buy?input:expected);
  if(buy&&order.mode==='percent'&&nativeValue>native)throw Error('买满目标比例超过 BNB 等值上限');
  return {platform:info.platform,phase:info.phase,token:info.token,action:order.action,unit,
    quoteAsset:quote,quoteDecimals,inputRaw:input.toString(),outputRaw:expected.toString(),
    expectedTokens:buy?formatUnits(expected,decimals):undefined,tokensToSell:!buy?formatUnits(input,decimals):undefined,
    quoteAmount:formatUnits(buy?input:expected,quoteDecimals),nativeValueBNB:formatEther(nativeValue),
    estimateOnly:true,priceImpactIncluded:true};
}
