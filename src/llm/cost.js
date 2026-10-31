/**
 * Estimated cost of one turn.
 *
 * Prices are owner-configured ¥ per 1M tokens. When any price is missing the
 * helper still reports token counts and a null cost, so the UI shows tokens
 * instead of inventing money.
 */

/**
 * Cost of one usage record.
 *
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number }} usage Usage.
 * @param {{ input?: number, output?: number, cache?: number }} prices ¥ per 1M tokens.
 * @returns {{ input: number, output: number, cache: number, cost: number | null }} Tokens and ¥.
 */
export function estimateCost(usage, prices) {
  const input = Number(usage?.inputTokens) || 0;
  const output = Number(usage?.outputTokens) || 0;
  const cache = Number(usage?.cacheReadTokens) || 0;
  const pIn = Number(prices?.input);
  const pOut = Number(prices?.output);
  const pCache = Number(prices?.cache);
  if (!Number.isFinite(pIn) || !Number.isFinite(pOut) || !Number.isFinite(pCache) || (pIn === 0 && pOut === 0 && pCache === 0)) {
    return { input, output, cache, cost: null };
  }
  return { input, output, cache, cost: (input * pIn + output * pOut + cache * pCache) / 1_000_000 };
}

/**
 * Sum estimates, keeping "unknown price" honest.
 *
 * @param {ReadonlyArray<{ input: number, output: number, cache: number, cost: number | null }>} rows Estimates.
 * @returns {{ input: number, output: number, cache: number, cost: number | null }} Totals.
 */
export function sumCosts(rows) {
  let input = 0;
  let output = 0;
  let cache = 0;
  let cost = 0;
  let complete = true;
  for (const row of rows) {
    input += row.input;
    output += row.output;
    cache += row.cache;
    if (row.cost === null) complete = false;
    else cost += row.cost;
  }
  return { input, output, cache, cost: complete ? cost : null };
}

/**
 * Cache hit share of the input tokens, 0..1.
 *
 * @param {{ input: number, cache: number }} tokens Token totals.
 * @returns {number} Hit rate.
 */
export function cacheRate(tokens) {
  const total = (Number(tokens?.input) || 0) + (Number(tokens?.cache) || 0);
  if (total === 0) return 0;
  return (Number(tokens?.cache) || 0) / total;
}
