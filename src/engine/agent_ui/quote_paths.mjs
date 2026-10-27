import { Contract, getAddress } from 'ethers';
import { ABI, ROUTER, WBNB, verifiedPair } from './platforms.mjs';

export const STABLE_QUOTES = [
  getAddress('0x55d398326f99059fF775485246999027B3197955'),
  getAddress('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'),
];
const caches=new WeakMap();
export async function quotePaths(provider,quote) {
  quote=getAddress(quote);
  if(quote===WBNB)return [[WBNB]];
  let cache=caches.get(provider);if(!cache){cache=new Map();caches.set(provider,cache);}
  const hit=cache.get(quote);if(hit&&Date.now()-hit.at<60_000)return hit.paths;
  const candidates=[[WBNB,quote],...STABLE_QUOTES.filter(s=>s!==quote).map(s=>[WBNB,s,quote])];
  const checked=await Promise.all(candidates.map(async path=>{
    const pairs=await Promise.all(path.slice(1).map((asset,i)=>verifiedPair(provider,path[i],asset).catch(()=>null)));
    return pairs.every(Boolean)?path:null;
  }));
  const paths=checked.filter(Boolean);
  if(!paths.length)throw Error('quote_swap_route_unavailable');
  cache.set(quote,{at:Date.now(),paths});return paths;
}
export async function bestPathQuote(provider,paths,amount,exactOutput=false) {
  const router=new Contract(ROUTER,ABI.PCS_ROUTER,provider);
  const results=await Promise.all(paths.map(async path=>{
    try{if(path.length===1)return {path,amount,amounts:[amount]};
      const amounts=exactOutput?await router.getAmountsIn(amount,path):await router.getAmountsOut(amount,path);
      return {path,amount:exactOutput?amounts[0]:amounts.at(-1),amounts};
    }catch{return null;}
  }));
  const valid=results.filter(x=>x&&x.amount>0n);
  if(!valid.length)throw Error('quote_swap_route_unavailable');
  return valid.reduce((a,b)=>exactOutput?(a.amount<b.amount?a:b):(a.amount>b.amount?a:b));
}
export async function quoteCapacity(provider,quote,budget,nativeAvailable,existing) {
  if(getAddress(quote)===WBNB)return budget<existing+nativeAvailable?budget:existing+nativeAvailable;
  const paths=await quotePaths(provider,quote);
  const [cap,newFunds]=await Promise.all([
    bestPathQuote(provider,paths,budget*98n/100n),
    nativeAvailable>0n?bestPathQuote(provider,paths,nativeAvailable*98n/100n):{amount:0n},
  ]);
  return cap.amount<existing+newFunds.amount?cap.amount:existing+newFunds.amount;
}
