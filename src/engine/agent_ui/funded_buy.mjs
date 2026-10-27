const min=(a,b)=>a<b?a:b;
export function inputPriceCap(initial,slippageBps){return (BigInt(initial)*(10000n+BigInt(slippageBps))+9999n)/10000n;}
// A first quote is a price reference, never the user's spending budget.
export async function prepareFundedBuy({initialGross,slippageBps,capacity,balance,fund,approve,refresh,emit=()=>{}}){
  const priceCap=inputPriceCap(initialGross,slippageBps);
  for(let round=0;round<3;round++){
    const budgetCap=await capacity(),cap=min(priceCap,budgetCap);
    if(cap<=0n)throw Error('budget_insufficient_for_target');
    const need=await refresh(cap);let available=await balance();
    if(available<need.gross){if(await fund(cap)===null)return null;available=await balance();}
    const usable=min(cap,available);if(usable<need.gross)throw Error('quote_acquired_but_target_unavailable');
    if(!await approve(usable))return null;
    try{const fresh=await refresh(usable);
      emit({stage:'funded_buy_ready',round:round+1,maximumQuote:String(cap),grossQuote:String(fresh.gross)});return fresh;
    }catch(e){if(e.message!=='budget_insufficient_for_target')throw e;
      const nextCap=min(priceCap,await capacity());
      if(nextCap>usable){emit({stage:'funding_price_recheck',round:round+1});continue;}
      throw Error(budgetCap<priceCap?'budget_insufficient_for_target':'buy_price_slippage_cap_exceeded');
    }
  }
  throw Error('price_changed_during_funding');
}
