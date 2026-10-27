// Gang V2 integer constant-product math, including the wallet-cap plateau.
const VT=1066666666666666666666666667n;
const ceil=(a,b)=>(a+b-1n)/b;
export function gangV2BuyQuote(c,gross,room){
  const reserve=VT-c.sold,qreserve=c.virtualQuote+c.realQuote;
  if(c.virtualQuote<=0n||reserve<=0n||c.gradAmt<=c.realQuote||gross<=0n)return 0n;
  let net=gross-gross/100n;if(net>c.gradAmt-c.realQuote)net=c.gradAmt-c.realQuote;
  let tokens=reserve-ceil(c.virtualQuote*VT,qreserve+net);
  if(room!==null&&tokens>room)tokens=room;
  return tokens>0n?tokens:0n;
}
export function gangV2RequiredQuote(c,desired){
  const reserve=VT-c.sold;if(desired<=0n||desired>=reserve)throw Error('gang_target_out_of_range');
  const net=ceil(c.virtualQuote*VT,reserve-desired)-(c.virtualQuote+c.realQuote);
  if(net<=0n)throw Error('gang_curve_quote_invalid');
  return ceil(net*10000n,9900n);
}
export function resolveGangBuyQuote(c,upper,desired,room,requireTarget=true){
  const output=gangV2BuyQuote(c,upper,room);
  if(output<desired){if(requireTarget)throw Error('budget_insufficient_for_target');return {gross:upper,output};}
  // The quote can equal `desired` for every larger input when walletRoom caps it.
  // Invert the curve instead of mistaking that plateau for a minimal input.
  const gross=gangV2RequiredQuote(c,desired),actual=gangV2BuyQuote(c,gross,room);
  if(gross>upper||actual<desired)throw Error('gang_exact_target_quote_invalid');
  return {gross,output:actual};
}
export function gangV2SellQuote(c,amount){const reserve=VT-c.sold;
  if(reserve<=0n)throw Error('gang_curve_exhausted');
  const gross=c.virtualQuote+c.realQuote-ceil(c.virtualQuote*VT,reserve+amount);
  return gross-gross/100n;
}
