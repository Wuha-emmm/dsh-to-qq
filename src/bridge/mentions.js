/**
 * Turn `@名字` in a reply into a real QQ mention.
 *
 * A model writes "@小明 你来看看" as plain text; QQ shows that as literal text
 * unless the message carries an `at` segment, so the person is never notified.
 * This module splits such a body into text/at segments using the names the
 * bridge already knows for that group.
 */

/** How a mention may be written: @全体成员, @123456, or @昵称. */
const MENTION = /@([^\s@，。！？、,.!?]{1,24})/g;

/**
 * Resolve one mention to a target.
 *
 * @param {string} name Text after the `@`.
 * @param {Map<string, number>} members Display name -> QQ number.
 * @returns {{ qq: number | 'all' } | undefined} Target, or undefined when unknown.
 */
function resolve(name, members) {
  if (name === '全体成员' || name === '全体' || name.toLowerCase() === 'all') return { qq: 'all' };
  if (/^\d{5,12}$/.test(name)) return { qq: Number(name) };
  const direct = members.get(name);
  if (direct !== undefined) return { qq: direct };
  // Tolerate a trailing "：" or "的" left by the model.
  const trimmed = name.replace(/[：:的]+$/, '');
  const fallback = members.get(trimmed);
  return fallback === undefined ? undefined : { qq: fallback };
}

/**
 * Split a reply body into OneBot segments, converting known mentions.
 *
 * @param {string} text Reply body.
 * @param {Map<string, number>} members Display name -> QQ number for this group.
 * @returns {Array<{ type: string, data: Record<string, unknown> }>} Segments.
 */
export function buildReplySegments(text, members) {
  const body = String(text ?? '');
  const segments = [];
  let cursor = 0;
  MENTION.lastIndex = 0;
  let match = MENTION.exec(body);
  while (match !== null) {
    const target = resolve(match[1], members);
    if (target === undefined) {
      // Leave an unknown @ as text: guessing a QQ number would ping a stranger.
      match = MENTION.exec(body);
      continue;
    }
    const start = match.index;
    if (start > cursor) segments.push({ type: 'text', data: { text: body.slice(cursor, start) } });
    const qq = target.qq === 'all' ? 'all' : String(target.qq);
    segments.push({ type: 'at', data: { qq } });
    cursor = start + match[0].length;
    match = MENTION.exec(body);
  }
  if (cursor < body.length) segments.push({ type: 'text', data: { text: body.slice(cursor) } });
  if (segments.length === 0) segments.push({ type: 'text', data: { text: body } });
  return segments;
}

/**
 * Collect display names from raw group member rows.
 *
 * @param {ReadonlyArray<any>} rows `get_group_member_list` result.
 * @returns {Map<string, number>} Display name -> QQ number.
 */
export function memberNames(rows) {
  const members = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const qq = Number(row?.user_id ?? row?.userId ?? 0);
    if (!Number.isInteger(qq) || qq <= 0) continue;
    for (const name of [row?.card, row?.nickname, row?.remark, String(qq)]) {
      if (typeof name === 'string' && name.trim() !== '') members.set(name.trim(), qq);
    }
  }
  return members;
}
