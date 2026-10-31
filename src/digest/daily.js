/**
 * Daily digest of one scene: who spoke, how much, when, and what kind of media.
 *
 * Numbers only — the model is not involved, so a digest never costs a turn and
 * never invents a summary that did not happen.
 */

/** Beijing offset in milliseconds. */
const BJ_OFFSET = 8 * 3600 * 1000;

/** How many speakers the ranking lists (two columns of five). */
const RANKING_LIMIT = 10;

/** Rows one digest may read from the archive. */
export const DIGEST_ROW_LIMIT = 20_000;

/**
 * Start of the Beijing day containing `now`, in epoch milliseconds.
 *
 * @param {number} [now] Epoch milliseconds.
 * @returns {number} Epoch milliseconds of 00:00 in Asia/Shanghai.
 */
export function startOfBeijingDay(now = Date.now()) {
  const shifted = now + BJ_OFFSET;
  return shifted - (shifted % 86_400_000) - BJ_OFFSET;
}

/**
 * Resolve a day selector into a Beijing-day window.
 *
 * The tool used to read only "today", so a request for 昨日日报 silently returned
 * the few hours of today that had already happened.
 *
 * @param {string} [input] `today`, `yesterday`, or `YYYY-MM-DD`.
 * @param {number} [now] Epoch milliseconds.
 * @returns {{ startMs: number, endMs: number, sinceUnix: number, untilUnix: number, label: string, key: string }} Window.
 */
export function dayRange(input = 'today', now = Date.now()) {
  const raw = String(input ?? '').trim().toLowerCase();
  let startMs = startOfBeijingDay(now);
  if (raw === 'yesterday' || raw === '昨天' || raw === '昨日') {
    startMs -= 86_400_000;
  } else if (raw === 'today' || raw === '今天' || raw === '今日' || raw === '') {
    // already today
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = Date.parse(`${raw}T00:00:00+08:00`);
    if (!Number.isNaN(parsed)) startMs = parsed;
  }
  const endMs = startMs + 86_400_000;
  const date = new Date(startMs + BJ_OFFSET);
  const label = `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  const key = `${date.getUTCFullYear()}-${label}`;
  return {
    startMs,
    endMs,
    sinceUnix: Math.floor(startMs / 1000),
    untilUnix: Math.floor(endMs / 1000),
    label,
    key,
  };
}

/**
 * Summarize archived rows.
 *
 * @param {ReadonlyArray<{ sender_id?: number, sender_name?: string, time_unix: number, media_kind?: string | null }>} rows Archive rows, any order.
 * @returns {{ total: number, senders: number, top: Array<[string, number]>, peakHour: number, peakCount: number, images: number, voices: number }} The numbers.
 */
export function summarizeDigest(rows) {
  /** @type {Map<string, number>} */
  const senders = new Map();
  const hours = new Array(24).fill(0);
  let images = 0;
  let voices = 0;
  let chars = 0;
  let longest = 0;
  let total = 0;

  for (const row of rows) {
    // Only what people said: the bot's own replies are in the archive too, and
    // counting them would inflate both the message total and the participant
    // count (the bot would appear as a member).
    if (row.direction === 'out') continue;
    const name = typeof row.sender_name === 'string' && row.sender_name !== ''
      ? row.sender_name
      : String(row.sender_id ?? '未知');
    senders.set(name, (senders.get(name) ?? 0) + 1);
    const hour = new Date((Number(row.time_unix) || 0) * 1000 + BJ_OFFSET).getUTCHours();
    hours[hour] += 1;
    if (row.media_kind === 'image') images += 1;
    if (row.media_kind === 'voice') voices += 1;
    const length = typeof row.text === 'string' ? row.text.length : 0;
    chars += length;
    if (length > longest) longest = length;
    total += 1;
  }

  const top = [...senders.entries()].sort((left, right) => right[1] - left[1]).slice(0, RANKING_LIMIT);
  const peakCount = Math.max(...hours);
  const peakHour = peakCount === 0 ? 0 : hours.indexOf(peakCount);
  return {
    total,
    senders: senders.size,
    top,
    peakHour,
    peakCount,
    images,
    voices,
    chars,
    avgPerSender: senders.size === 0 ? 0 : Math.round((total / senders.size) * 10) / 10,
    avgChars: total === 0 ? 0 : Math.round(chars / total),
    longest,
    hours,
  };
}

/**
 * Render the digest as chat text.
 *
 * @param {{ total: number, senders: number, top: Array<[string, number]>, peakHour: number, peakCount: number, images: number, voices: number }} summary Numbers from {@link summarizeDigest}.
 * @param {string} sceneLabel Human label for the scene.
 * @param {string} dayLabel Human label for the day.
 * @returns {string} Message body.
 */
export function formatDigest(summary, sceneLabel, dayLabel) {
  if (summary.total === 0) {
    return `${dayLabel} ${sceneLabel}：今天一条消息都没有。`;
  }
  const lines = [
    `${dayLabel} ${sceneLabel} 日报`,
    `消息 ${summary.total} 条，${summary.senders} 个人发言`,
  ];
  if (summary.peakCount > 0) {
    lines.push(`最热闹的时段：${String(summary.peakHour).padStart(2, '0')}:00 前后（${summary.peakCount} 条）`);
  }
  if (summary.images > 0 || summary.voices > 0) {
    const parts = [];
    if (summary.images > 0) parts.push(`图片 ${summary.images}`);
    if (summary.voices > 0) parts.push(`语音 ${summary.voices}`);
    lines.push(`媒体：${parts.join('，')}`);
  }
  if (summary.top.length > 0) {
    lines.push('发言最多：');
    for (const [name, count] of summary.top) lines.push(`  ${name} —— ${count} 条`);
  }
  return lines.join('\n');
}

