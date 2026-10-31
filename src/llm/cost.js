/**
 * Estimated cost of one turn.
 *
 * Prices are owner-configured ¥ per 1M tokens. When any price is missing the
 * helper still reports token counts and a null cost, so the UI shows tokens
 * instead of inventing money.
 */

/**
 * Parse `HH:MM-HH:MM[,HH:MM-HH:MM]` into minute ranges.
 *
 * @param {string} value Window list.
 * @returns {Array<{ start: number, end: number }>} Ranges in minutes.
 */
function parseWindows(value) {
  const ranges = [];
  for (const part of String(value ?? '').split(',')) {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(part.trim());
    if (match === null) continue;
    ranges.push({ start: Number(match[1]) * 60 + Number(match[2]), end: Number(match[3]) * 60 + Number(match[4]) });
  }
  return ranges;
}

/**
 * Whether a moment is billed at the peak rate.
 *
 * DeepSeek's peak window is Monday to Friday, 09:00-12:00 and 14:00-18:00
 * Beijing time, excluding listed holidays; everything else is half price.
 *
 * @param {number} at Epoch milliseconds.
 * @param {{ windows?: string, holidays?: string }} [schedule] Peak windows and YYYY-MM-DD holidays.
 * @returns {boolean} True when peak.
 */
export function isPeak(at, schedule = {}) {
  const date = new Date(Number(at) || Date.now());
  const weekday = date.getDay();
  if (weekday === 0 || weekday === 6) return false;
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const holidays = String(schedule.holidays ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (holidays.includes(stamp)) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return parseWindows(schedule.windows ?? '09:00-12:00,14:00-18:00')
    .some(range => minutes >= range.start && minutes < range.end);
}

/**
 * Cost of one usage record.
 *
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number }} usage Usage.
 * @param {{ input?: number, output?: number, cache?: number, offPeakDiscount?: number, peakWindows?: string, peakHolidays?: string }} prices ¥ per 1M tokens (peak), discount and peak schedule.
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
  const offPeak = !isPeak(at, { windows: prices?.peakWindows, holidays: prices?.peakHolidays });
  // No configured discount means the schedule does not apply at all.
  const configured = Number(prices?.offPeakDiscount);
  const discount = offPeak && Number.isFinite(configured) && configured > 0 && configured < 1 ? configured : 1;
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
