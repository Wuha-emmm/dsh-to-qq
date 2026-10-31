/**
 * Estimated cost of one turn.
 *
 * Prices are owner-configured ¥ per 1M tokens. When any price is missing the
 * helper still reports token counts and a null cost, so the UI shows tokens
 * instead of inventing money.
 */

/**
 * Whether a moment falls inside an off-peak window.
 *
 * @param {number} at Epoch milliseconds.
 * @param {string} window `HH:MM-HH:MM` in local time; empty disables the check.
 * @returns {boolean} True inside the window.
 */
export function isOffPeak(at, window) {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(window ?? '').trim());
  if (match === null) return false;
  const date = new Date(Number(at) || Date.now());
  const minutes = date.getHours() * 60 + date.getMinutes();
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * Cost of one usage record.
 *
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number }} usage Usage.
 * @param {{ input?: number, output?: number, cache?: number, offPeakDiscount?: number, offPeakWindow?: string }} prices ¥ per 1M tokens (peak), discount and window.
 * @param {number} [at] Epoch milliseconds of the turn; decides peak or off-peak.
 * @returns {{ input: number, output: number, cache: number, cost: number | null, offPeak: boolean }} Tokens and ¥.
 */
export function estimateCost(usage, prices, at = Date.now()) {
  const input = Number(usage?.inputTokens) || 0;
  const output = Number(usage?.outputTokens) || 0;
  const cache = Number(usage?.cacheReadTokens) || 0;
  const pIn = Number(prices?.input);
  const pOut = Number(prices?.output);
  const pCache = Number(prices?.cache);
  if (!Number.isFinite(pIn) || !Number.isFinite(pOut) || !Number.isFinite(pCache) || (pIn === 0 && pOut === 0 && pCache === 0)) {
    return { input, output, cache, cost: null, offPeak: false };
  }
  const offPeak = isOffPeak(at, prices?.offPeakWindow);
  const discount = offPeak ? Math.min(1, Math.max(0, Number(prices?.offPeakDiscount) || 0)) : 1;
  const cost = (input * pIn + output * pOut + cache * pCache) / 1_000_000 * discount;
  return { input, output, cache, cost, offPeak };
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
