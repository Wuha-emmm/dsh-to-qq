/**
 * Describing stickers with the model.
 *
 * QQ only ships a description for a handful of custom faces, so the library
 * learns the rest: download the preview, hand it to a vision-capable model, and
 * keep a structured line per sticker.
 *
 * A literal caption ("蓝发女孩敲键盘") is useless when the model later has to
 * decide whether to send it. The prompt therefore asks for three things — what
 * is in the picture, which emotion it carries, and when it fits — and the
 * parser splits that into the `desc` and `category` fields the settings page and
 * the catalog use.
 */

/** Emotion buckets the catalog groups by. */
export const MOODS = ['开心', '卖萌', '无语', '嘲讽', '震惊', '难过', '鼓励', '感谢', '疑问', '敷衍', '其他'];

/** Instruction that keeps answers structured and usable as catalog lines. */
export const DESCRIBE_SYSTEM = [
  '你在给 QQ 收藏表情建立索引，供之后按语境挑选发送。',
  '对每张图只输出一行，用竖线分成三段：画面|情绪|用途。',
  '画面 ≤ 14 字：主体加关键动作；图里有文字就先写文字。',
  `情绪从这些里选一个：${MOODS.join('/')}。`,
  '用途 ≤ 16 字：什么情况下该发它。',
  '不要编号、引号、解释或前后缀。',
].join('\n');

/**
 * Build the describing prompt for one sticker.
 *
 * @param {{ desc?: string, category?: string }} [sticker] Existing values, when the transport had some.
 * @returns {string} User prompt.
 */
export function describePrompt(sticker = {}) {
  const existing = String(sticker.desc ?? '').trim();
  const category = String(sticker.category ?? '').trim();
  const parts = ['看这张 QQ 收藏表情，按“画面|情绪|用途”写一行索引。'];
  if (existing !== '') parts.push(`已有的粗略描述：${existing}`);
  if (category !== '') parts.push(`已有的分类：${category}`);
  parts.push('只输出这一行，三段都要有。');
  return parts.join('\n');
}

/**
 * Normalize one emotion segment into a known bucket.
 *
 * @param {string} raw Raw segment.
 * @returns {string} A mood from {@link MOODS}, or the trimmed text when short.
 */
export function normalizeMood(raw) {
  // "嘲讽/开心" means the model offered synonyms: the first one is the answer.
  const first = String(raw ?? '').split(/[/、,，;；]/)[0] ?? '';
  const text = first.replace(/[\s。]+/g, '');
  if (text === '') return '';
  const exact = MOODS.find(mood => text === mood);
  if (exact !== undefined) return exact;
  const contained = MOODS.find(mood => text.includes(mood));
  if (contained !== undefined) return contained;
  return text.slice(0, 4);
}

/**
 * Parse one model answer into `{ desc, category }`.
 *
 * Accepts the structured `画面|情绪|用途` shape, and degrades to a plain
 * description when the model ignores the format.
 *
 * @param {string} text Model output.
 * @returns {{ desc: string, category: string }} Fields for the store; both may be ''.
 */
export function parseAnalysis(text) {
  const first = String(text ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')[0] ?? '';
  if (first === '') return { desc: '', category: '' };
  const cleaned = first
    .replace(/^[-*•\d.、)\s]+/, '')
    .replace(/^["「『]|["」』]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const parts = cleaned.split(/[|｜]/).map(part => part.trim()).filter(part => part !== '');
  if (parts.length >= 2) {
    const scene = parts[0].slice(0, 30);
    const category = normalizeMood(parts[1]);
    const when = (parts[2] ?? '').slice(0, 30);
    // The catalog reads better as "画面，用途"; the mood lives in its own field.
    const desc = [scene, when].filter(part => part !== '').join('，');
    return { desc: desc.slice(0, 60), category };
  }
  return { desc: cleaned.slice(0, 60), category: '' };
}

/**
 * Clean one model answer into a catalog line (legacy helper).
 *
 * @param {string} text Model output.
 * @returns {string} Description, or '' when the answer is unusable.
 */
export function parseDescription(text) {
  return parseAnalysis(text).desc.slice(0, 40);
}
