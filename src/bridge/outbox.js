/**
 * Rules for a media message that carries text.
 *
 * A screenshot is evidence; the words around it are the point. A long caption is
 * never thrown away: it is merged with the turn's reply so the person gets one
 * message that says everything, and a caption already inside the reply is not
 * repeated.
 */

/** Longest caption that reads as a label rather than a paragraph. */
export const CAPTION_LIMIT = 30;

/**
 * Normalize a caption. Captions are no longer cut — a long one is merged into
 * the reply instead, so nothing the model wrote disappears.
 *
 * @param {string} text Raw caption.
 * @returns {{ text: string, truncated: boolean }} Caption and whether it was cut
 *   (kept for callers that still read the flag; always false now).
 */
export function captionOf(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { text: '', truncated: false };
  return { text: raw, truncated: false };
}

/**
 * Pick the text that goes out with queued media.
 *
 * The reply leads, and any caption it does not already contain is appended on
 * its own line, so a long caption survives instead of being truncated. When the
 * turn has no reply text, the captions are all there is, so they are joined.
 *
 * @param {string} reply Final assistant text.
 * @param {ReadonlyArray<string>} captions Captions from the queued sends.
 * @returns {string} Text for the merged message.
 */
export function mergeText(reply, captions) {
  const body = String(reply ?? '').trim();
  const extras = (Array.isArray(captions) ? captions : [])
    .map(caption => String(caption ?? '').trim())
    .filter(caption => caption !== '');
  if (body === '') return [...new Set(extras)].join('\n');
  const fresh = [...new Set(extras)].filter(caption => !body.includes(caption));
  return fresh.length === 0 ? body : `${body}\n${fresh.join('\n')}`;
}

/** How long a queued picture stays valid; older items are dropped. */
export const MEDIA_TTL_MS = 5 * 60_000;

/**
 * Split a queue into fresh and stale items.
 *
 * A turn that fails after queueing must not leak its picture into a later turn,
 * and any path that forgets to flush still cannot resurrect an old screenshot.
 *
 * @param {ReadonlyArray<{ at?: number }>} items Queued items.
 * @param {number} [now] Epoch milliseconds.
 * @param {number} [ttlMs] Maximum age.
 * @returns {{ fresh: any[], stale: any[] }} Partition.
 */
export function pruneQueue(items, now = Date.now(), ttlMs = MEDIA_TTL_MS) {
  const fresh = [];
  const stale = [];
  for (const item of Array.isArray(items) ? items : []) {
    const at = Number(item?.at) || 0;
    if (at > 0 && now - at > ttlMs) stale.push(item);
    else fresh.push(item);
  }
  return { fresh, stale };
}
