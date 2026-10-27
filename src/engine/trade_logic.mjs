// Pure trade guards. All amounts are bigint in the chain asset's smallest unit.
export const ZAP_NATIVE = 2n;

export function makeBuyPlan({ estimate, quoteIsWrappedNative, nativeBudgetWei,
  maxTotalFeeBps = 2500n, slippageBps = 3000n }) {
  const curveQuote = BigInt(estimate.curveQuote);
  const totalFee = BigInt(estimate.totalFee);
  const userPays = BigInt(estimate.userPays);
  const tokenAmount = BigInt(estimate.tokenAmount);
  const budget = BigInt(nativeBudgetWei);
  if (curveQuote <= 0n || tokenAmount <= 0n || budget <= 0n) throw new Error('buy_not_executable');
  if (totalFee < 0n || totalFee * 10000n > curveQuote * maxTotalFeeBps) {
    throw new Error('buy_fee_cap_exceeded');
  }
  if (slippageBps < 0n || slippageBps > 10000n) throw new Error('bad_buy_slippage');
  if (userPays <= 0n || userPays > budget) throw new Error('native_budget_exceeded');
  const minTokenOut = tokenAmount * (10000n - slippageBps) / 10000n;
  const maxNativePay=(userPays*(10000n+slippageBps)+9999n)/10000n;
  if (minTokenOut <= 0n) throw new Error('min_token_out_zero');
  return {
    maxQuotePay: quoteIsWrappedNative ? (budget<maxNativePay?budget:maxNativePay) :
      ((curveQuote+totalFee)*(10000n+slippageBps)+9999n)/10000n,
    minTokenOut,
    options: quoteIsWrappedNative ? 0n : ZAP_NATIVE,
    valueWei: budget,
    feeBpsFloor: totalFee * 10000n / curveQuote,
  };
}

export function priceReached3x({ currentBnbPerTokenWei, tokensBoughtWei,
  actualBnbSpentWei }) {
  const current = BigInt(currentBnbPerTokenWei);
  const tokens = BigInt(tokensBoughtWei);
  const spent = BigInt(actualBnbSpentWei);
  if (current <= 0n || tokens <= 0n || spent <= 0n) return false;
  // Both sides are scaled by 1e18 token wei; no floating-point price math.
  return current * tokens >= 3n * spent * 10n ** 18n;
}

export function minimumSellReceive({ principalWei, expectedSellGasWei }) {
  const principal = BigInt(principalWei);
  const gas = BigInt(expectedSellGasWei);
  if (principal <= 0n || gas < 0n) throw new Error('bad_sell_target');
  return principal + gas;
}

export function latestHead(health) {
  return Math.max(Number(health?.lastWsHeadBlock || 0), Number(health?.httpHeadBlock || 0));
}

// Price and target are both denominated in BNB, including for stock quote pools.
export async function recoverySellAmount({ targetWei, balance, nativeUnitPriceWei, estimate }) {
  const target = BigInt(targetWei);
  const total = BigInt(balance);
  const price = BigInt(nativeUnitPriceWei);
  if (target <= 0n || total <= 0n || price <= 0n) throw new Error('bad_sell_quote_input');
  let upper = (target * 10n ** 18n + price - 1n) / price;
  if (upper > total) upper = total;
  if (upper < 1n) upper = 1n;
  let quote = await estimate(upper);
  for (let i = 0; quote.est.userReceives < target && upper < total && i < 4; i++) {
    const out = quote.est.userReceives;
    upper = out > 0n ? (upper * target * 102n + out * 100n - 1n) / (out * 100n) : total;
    if (upper > total) upper = total;
    quote = await estimate(upper);
  }
  if (quote.est.userReceives < target && upper < total) {
    upper = total;
    quote = await estimate(upper);
  }
  if (quote.est.userReceives < target || quote.est.tokenAmount !== upper)
    throw new Error('cannot_recover_principal_in_sell_quote');
  let lower = 0n;
  // Parallel quarter searches narrow the interval to 1/256 in four round trips.
  for (let round = 0; round < 4 && upper - lower > total / 10000n + 1n; round++) {
    const points = [...new Set([1n, 2n, 3n].map(n => lower + (upper - lower) * n / 4n))]
      .filter(n => n > lower && n < upper);
    const quotes = await Promise.all(points.map(estimate));
    for (let i = 0; i < points.length; i++) {
      if (quotes[i].est.userReceives >= target && quotes[i].est.tokenAmount === points[i]) {
        upper = points[i]; quote = quotes[i]; break;
      }
      lower = points[i];
    }
  }
  return { amount: upper, quote };
}
