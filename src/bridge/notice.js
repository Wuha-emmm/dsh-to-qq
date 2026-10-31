/**
 * Suppress a fixed notice the bridge already sent.
 *
 * The approval acknowledgement is a template ("已放行 pwsh …"), so a long task
 * that needs two approvals put the same sentence in the chat twice, minutes apart.
 * The model's own replies are never filtered — only these bridge notices are.
 */

/** How long an identical notice stays suppressed. */
export const NOTICE_TTL_MS = 10 * 60_000;

/**
 * Decide whether a notice should go out, remembering it when it does.
 *
 * @param {Map<string, { text: string, at: number }>} seen Per-scene memory.
 * @param {string} scene Scene key.
 * @param {string} text Notice body.
 * @param {number} [now] Epoch milliseconds.
 * @param {number} [ttlMs] Suppression window.
 * @returns {boolean} True when the notice is new enough to send.
 */
export function shouldSendNotice(seen, scene, text, now = Date.now(), ttlMs = NOTICE_TTL_MS) {
  const body = String(text ?? '').trim();
  if (body === '') return false;
  const previous = seen.get(scene);
  if (previous !== undefined && previous.text === body && now - previous.at < ttlMs) return false;
  seen.set(scene, { text: body, at: now });
  return true;
}
