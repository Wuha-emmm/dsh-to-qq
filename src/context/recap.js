/**
 * The hand-off note used when a session is rebuilt.
 *
 * Rebuilding drops a session whose history has grown expensive, so the new one
 * needs the tail of the conversation to stay coherent. Only the last few
 * messages are carried over: earlier history is what we are deliberately
 * dropping, and the memory card already covers who the person is.
 */

/**
 * Format the recap block for one scene.
 *
 * @param {ReadonlyArray<{ sender_name?: string, sender_id?: number, text?: string }>} rows Archive rows, newest first.
 * @param {{ limit?: number, maxChars?: number }} [options] Budget.
 * @returns {string} Recap text, or '' when there is nothing to carry over.
 */
export function formatRecap(rows, options = {}) {
  const limit = Math.max(0, Number(options.limit) || 12);
  const maxChars = Math.max(200, Number(options.maxChars) || 1500);
  const picked = (Array.isArray(rows) ? rows : [])
    .filter(row => typeof row?.text === 'string' && row.text.trim() !== '')
    .slice(0, limit)
    .reverse();
  if (picked.length === 0) return '';

  const lines = [];
  let used = 0;
  for (const row of picked) {
    const who = String(row.sender_name ?? row.sender_id ?? '某人').slice(0, 24);
    const say = String(row.text).trim().replace(/\s+/g, ' ').slice(0, 80);
    const line = `${who}: ${say}`;
    if (used + line.length > maxChars - 80) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return '';
  return [
    '【会话续接】上一个会话的历史已归档，下面是它最后的几条消息，只用来保持上下文，不要复述：',
    ...lines,
  ].join('\n');
}
