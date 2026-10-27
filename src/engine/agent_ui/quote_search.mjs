// Find the smallest practical input for a monotone on-chain quote.
// Secant probes converge quickly on bonding curves; every candidate is checked
// against the contract's current quote before it can be used.
export async function findGross(upper, desired, quote) {
  if (upper <= 0n || desired <= 0n) throw new Error('invalid_quote_search');
  let high = upper;
  let highOut = await quote(high);
  if (highOut < desired) return null;
  let low = 0n;
  let lowOut = 0n;
  const tolerance = desired / 10000n || 1n;
  for (let i = 0; i < 10 && highOut - desired > tolerance && high - low > 1n; i++) {
    let probe = low + (high - low) * (desired - lowOut) / (highOut - lowOut);
    if (probe <= low || probe >= high) probe = (low + high) / 2n;
    const found = await quote(probe);
    if (found >= desired) { high = probe; highOut = found; }
    else { low = probe; lowOut = found; }
  }
  if (highOut - desired > tolerance) throw new Error('quote_search_not_converged');
  return { gross: high, output: highOut };
}

// Keep the search result and its integer amount distinct at every call site.
export async function resolveBuyQuote(upper, desired, quote, requireTarget = true) {
  const result = await findGross(upper, desired, quote);
  if (!result && requireTarget) throw new Error('budget_insufficient_for_target');
  const resolved = result || { gross: upper, output: await quote(upper) };
  if (typeof resolved.gross !== 'bigint' || typeof resolved.output !== 'bigint')
    throw new Error('invalid_quote_result');
  return resolved;
}
