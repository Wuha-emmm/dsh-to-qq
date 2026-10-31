/**
 * Rules for a media message that carries text.
 *
 * A screenshot is evidence; the conclusion belongs in the reply. When the model
 * writes a long caption it is repeating the conclusion, and the reply then says
 * the same thing again — measured on a real session, every duplicate had a caption
 * of 40+ characters while captions under 30 read as labels.
 *
 * So: a short caption is kept, a long one is cut, and any caption means the media
 * waits for the end of the turn so text and picture arrive as one message.
 */

/** Longest caption kept; anything past this belongs in the reply. */
export const CAPTION_LIMIT = 30;

/**
 * Normalize a caption, cutting it at the limit.
 *
 * @param {string} text Raw caption.
 * @returns {{ text: string, truncated: boolean }} Caption and whether it was cut.
 */
export function captionOf(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { text: '', truncated: false };
  if (raw.length <= CAPTION_LIMIT) return { text: raw, truncated: false };
  return { text: `${raw.slice(0, CAPTION_LIMIT)}…`, truncated: true };
}

/**
 * Pick the text that goes out with queued media.
 *
 * The reply supersedes the captions: one message, no repetition. When the turn has
 * no reply text, the captions are all there is, so they are joined.
 *
 * @param {string} reply Final assistant text.
 * @param {ReadonlyArray<string>} captions Captions from the queued sends.
 * @returns {string} Text for the merged message.
 */
export function mergeText(reply, captions) {
  const body = String(reply ?? '').trim();
  if (body !== '') return body;
  return (Array.isArray(captions) ? captions : [])
    .map(caption => String(caption ?? '').trim())
    .filter(caption => caption !== '')
    .join(' ');
}
