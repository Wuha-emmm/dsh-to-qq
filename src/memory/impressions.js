/**
 * Batch impression builder.
 *
 * Every so many messages a person writes — group chatter included, across every
 * scene — one summarizer run merges what they said into the impression list on
 * their card. Everything here is pure so the rules stay testable.
 */

/** Defaults used when the configuration omits a knob. */
export const IMPRESSION_DEFAULTS = {
  every: 100,
  minChars: 800,
  budgetChars: 600,
  maxNotes: 8,
};

/**
 * Whether a batch carries enough substance to be worth summarizing.
 *
 * A hundred messages of "草" and stickers produce nothing but noise, so the run
 * waits for real text instead of writing a meaningless impression.
 *
 * @param {ReadonlyArray<{ text?: string }>} batch Messages in reading order.
 * @param {number} [minChars] Minimum total characters.
 * @returns {boolean} True when the batch is worth a summarizer call.
 */
export function enoughSignal(batch, minChars = IMPRESSION_DEFAULTS.minChars, minDistinct = 20) {
  if (!Array.isArray(batch) || batch.length === 0) return false;
  let chars = 0;
  const distinct = new Set();
  for (const row of batch) {
    const text = String(row?.text ?? '').trim();
    if (text === '') continue;
    chars += text.length;
    distinct.add(text);
  }
  return chars >= minChars && distinct.size >= minDistinct;
}

/**
 * Render the summarizer prompt.
 *
 * @param {object} input Prompt input.
 * @param {string} input.name Display name.
 * @param {number} input.qq QQ number.
 * @param {ReadonlyArray<{ text: string }>} input.previous Existing impressions.
 * @param {ReadonlyArray<{ text: string, scene?: string, timeLabel?: string }>} input.batch New messages.
 * @param {number} [input.maxNotes] Cap on produced bullets.
 * @returns {string} Prompt text.
 */
export function buildImpressionPrompt(input) {
  const maxNotes = input.maxNotes ?? IMPRESSION_DEFAULTS.maxNotes;
  const lines = [];
  lines.push(`你要更新一份「对某个人的印象」，对象是 ${input.name}（QQ ${input.qq}）。`);
  lines.push('');
  lines.push('【已有印象】');
  if (input.previous.length === 0) lines.push('（空）');
  for (const note of input.previous) lines.push(`- ${note.text}`);
  lines.push('');
  lines.push('【最近的发言】');
  for (const row of input.batch) {
    const where = row.scene === undefined ? '' : `${row.scene} `;
    lines.push(`- ${where}${String(row.text ?? '').trim()}`);
  }
  lines.push('');
  lines.push('要求：');
  lines.push(`1. 把已有印象和这批发言合并，输出 ${Math.max(3, Math.floor(maxNotes / 2))}~${maxNotes} 条中文短句。`);
  lines.push('2. 每条 ≤ 30 字，只写事实和稳定偏好：在做什么、在意什么、说话习惯。');
  lines.push('3. 合并同义项，删掉过期或互相冲突的旧条目。');
  lines.push('4. 不写"很活跃""话很多"这类空话，也不写"要简短回答"这类说话规则（那属于人设）。');
  lines.push('5. 只输出条目本身，每行一条，以 "- " 开头，不要编号、标题或解释。');
  return lines.join('\n');
}

/** Lines that are clearly meta text, not an impression. */
const META_PREFIXES = ['以下', '要求', '注意', '合并', '输出', '整理', '说明', '摘要', '印象如下'];
const META_SUFFIXES = ['：', ':'];

/**
 * Decide whether a bare line (no bullet marker) is still an impression.
 *
 * The model sometimes answers with plain sentences; throwing them away costs a
 * whole summarizer run, so a short declarative line is accepted while obvious
 * preamble ("以下是…："）is not.
 *
 * @param {string} line Trimmed line.
 * @returns {boolean} True when the line can be used as an impression.
 */
function acceptableBareLine(line) {
  if (line.length === 0 || line.length > 60) return false;
  if (META_SUFFIXES.some(suffix => line.endsWith(suffix))) return false;
  if (META_PREFIXES.some(prefix => line.startsWith(prefix))) return false;
  if (/^\d+[.、)）]\s*/.test(line)) return true;
  return !/^(好的|以下是|希望)/.test(line);
}

/**
 * Strip a list marker from one line.
 *
 * @param {string} line Trimmed line.
 * @returns {{ text: string, marked: boolean }} Body and whether a marker was present.
 */
function stripMarker(line) {
  const bullet = /^[-•·*]\s*(.+)$/.exec(line);
  if (bullet !== null) return { text: bullet[1], marked: true };
  const numbered = /^\d+[.、)）]\s*(.+)$/.exec(line);
  if (numbered !== null) return { text: numbered[1], marked: true };
  return { text: line, marked: false };
}

/**
 * Parse the summarizer output into note objects.
 *
 * Accepts bullets, numbered lists, and bare short sentences, because a run that
 * returns usable facts in the wrong shape should not be wasted.
 *
 * @param {string} text Model output.
 * @param {{ at?: number, budgetChars?: number, maxNotes?: number, allowBare?: boolean }} [options] Parsing options; llowBare accepts plain sentences.
 * @returns {Array<{ at: number, text: string }>} Notes, oldest first after trimming.
 */
export function parseImpressionBullets(text, options = {}) {
  const at = options.at ?? Date.now();
  const budget = options.budgetChars ?? IMPRESSION_DEFAULTS.budgetChars;
  const maxNotes = options.maxNotes ?? IMPRESSION_DEFAULTS.maxNotes;
  const allowBare = options.allowBare === true;
  const bullets = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const { text: body, marked } = stripMarker(line);
    const cleaned = body.trim().replace(/^["「]|["」]$/g, '').slice(0, 60);
    if (cleaned === '') continue;
    if (!marked && !(allowBare && acceptableBareLine(cleaned))) continue;
    if (!bullets.includes(cleaned)) bullets.push(cleaned);
  }
  if (bullets.length === 0) return [];
  // Keep the newest entries when over budget; the list is produced in priority order.
  const kept = [];
  let used = 0;
  for (const body of bullets) {
    if (kept.length >= maxNotes) break;
    if (used + body.length > budget && kept.length > 0) break;
    kept.push(body);
    used += body.length;
  }
  return kept.map(body => ({ at, text: body }));
}


