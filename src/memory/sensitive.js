/**
 * Privacy filter for memory notes.
 *
 * The impressions summarize what a person does; left alone they happily record
 * "远程开 WeGame 登录账号截图", which is exactly the kind of fact a card should
 * not keep or render. Credentials, remote-control habits and captures are
 * dropped outright, while a bare local path is softened rather than removed.
 */

/** Patterns that make a note too sensitive to keep at all. */
export const HARD_PATTERNS = [
  // Remote control of the machine.
  /(远程|遥控|remote).{0,8}(控制|操作|开机|关机|桌面|电脑)/i,
  /(开机|关机|重启|锁屏|熄屏)/,
  // Account sign-in or credentials.
  /(登录|登陆|扫码).{0,8}(账号|帐号|帐密|密码|游戏|客户端|wegame|steam|qq)/i,
  /(账号|帐号|帐密|密码|password|passwd|totp|验证码)/i,
  /(token|密钥|api[-_ ]?key|private[-_ ]?key|secret)/i,
  // Screen capture.
  /(截图|截屏|screenshot|录屏)/i,
  // Phone numbers.
  /(?:^|\D)1[3-9]\d{9}(?:\D|$)/,
];

/** A local absolute path: keep the fact, hide the layout. */
const PATH_PATTERN = /(?:^|[^A-Za-z])([A-Za-z]:[\\/]{1,2}[^\s，。；、）)]*)/g;

/**
 * Whether one note carries something that must never reach a card.
 *
 * @param {string} text Note text.
 * @param {ReadonlyArray<RegExp>} [extra] Owner-supplied extra patterns.
 * @returns {boolean} True when the note must be dropped.
 */
export function isSensitiveNote(text, extra = []) {
  const body = String(text ?? '');
  if (body === '') return false;
  for (const pattern of HARD_PATTERNS) {
    if (pattern.test(body)) return true;
  }
  for (const pattern of extra) {
    if (pattern instanceof RegExp && pattern.test(body)) return true;
  }
  return false;
}

/**
 * Sanitize one note.
 *
 * @param {string} text Note text.
 * @param {ReadonlyArray<RegExp>} [extra] Extra patterns that force a drop.
 * @returns {{ dropped: boolean, text: string, softened: boolean }} Outcome.
 */
export function sanitizeNote(text, extra = []) {
  const body = String(text ?? '');
  if (isSensitiveNote(body, extra)) return { dropped: true, text: '', softened: false };
  const softened = body.replace(PATH_PATTERN, (match, path) => match.replace(path, '本地路径'));
  return { dropped: false, text: softened, softened: softened !== body };
}

/**
 * Drop or soften sensitive notes, keeping the rest untouched.
 *
 * @param {Array<{ at: number, text: string }>} notes Notes as stored.
 * @param {ReadonlyArray<RegExp>} [extra] Extra patterns.
 * @returns {{ notes: Array<{ at: number, text: string }>, dropped: number, softened: number }} Filtered notes and counters.
 */
export function filterNotes(notes, extra = []) {
  const kept = [];
  let dropped = 0;
  let softened = 0;
  for (const note of Array.isArray(notes) ? notes : []) {
    if (note === null || typeof note !== 'object') continue;
    const result = sanitizeNote(note.text, extra);
    if (result.dropped) {
      dropped += 1;
      continue;
    }
    if (result.softened) softened += 1;
    kept.push({ ...note, text: result.text });
  }
  return { notes: kept, dropped, softened };
}

/**
 * Compile the owner's extra words into patterns.
 *
 * @param {ReadonlyArray<string>} words Plain words from the config.
 * @returns {RegExp[]} Case-insensitive patterns.
 */
export function compileWords(words) {
  return (Array.isArray(words) ? words : [])
    .filter(word => typeof word === 'string' && word.trim() !== '')
    .map(word => new RegExp(word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}
