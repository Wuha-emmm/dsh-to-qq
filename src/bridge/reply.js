/**
 * Decide whether a turn's text should be sent at all.
 *
 * Sending a card is the whole answer: anything the model adds afterwards is
 * noise, no matter how long it is. Failures take a different path — the tool
 * throws, no card is counted, and the text (or the fallback) goes out normally.
 *
 * A third case exists: the provider sometimes returns the tail of a tool-call
 * envelope as plain text (for example `</antmlinvoke>` or
 * `<</｜｜DSML｜｜ parameter>`). The real answer was never emitted, so there is
 * nothing worth sending — see `isEnvelopeDebris`.
 */

/** Standalone envelope words, stripped before deciding what is left. */
const ENVELOPE_TOKENS = /(?:antml:?|DSML|function_calls|tool_calls|invoke|parameter)/gi;

/** Characters that may surround a tag without carrying meaning. */
const MARKUP_PUNCTUATION = /[\s:;,.!?()"'`<>[\]{}\\|/｜-]/g;

/** Invisible characters the provider leaves around a broken tag. */
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff]/g;

/** Any CJK character means the model wrote prose, not a tag. */
const CJK = /[\u3400-\u9fff]/;

/**
 * Whether the assistant text should be dropped after a card went out.
 *
 * @param {string} text Final assistant text.
 * @param {{ cardSent: boolean }} context What the turn did.
 * @returns {boolean} True when the text should not be sent.
 */
export function shouldStaySilent(text, context) {
  void text;
  return context.cardSent === true;
}

/**
 * Whether a turn produced the leftover of a tool-call envelope instead of prose.
 *
 * The provider converts the model's native tool-call markup into `tool_use`
 * blocks and strips the markup. When that conversion fails halfway, the opening
 * is swallowed and the closing tags come back as ordinary text. Such a text has
 * no words of its own: once the tags, the envelope keywords and the punctuation
 * are removed, nothing is left.
 *
 * The check is structural rather than a keyword list, because the model
 * misspells the tag it never opened (`</anthml>` and `</antml>` both turned up
 * in the same group). A short reply that starts with `<`, carries no CJK and
 * leaves nothing after the tags are stripped is debris; a real answer keeps its
 * words (`别输出 </antml:function_calls>` survives), and `<3` keeps its digit.
 *
 * @param {string} text Final assistant text.
 * @returns {boolean} True when the text is only envelope debris.
 */
export function isEnvelopeDebris(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '' || trimmed.length > 200) return false;
  if (!trimmed.startsWith('<')) return false;
  if (CJK.test(trimmed)) return false;
  const residue = trimmed
    .replace(INVISIBLE, '')
    .replace(/<[^>]{0,160}>/g, '')
    .replace(ENVELOPE_TOKENS, '')
    .replace(MARKUP_PUNCTUATION, '');
  if (residue === '') return true;
  // A fragment that still names an envelope keyword and keeps no word of its
  // own is debris too, even when the broken tag left a stray character behind.
  return /dsml|antml|function_calls|tool_calls/i.test(trimmed) && residue.length <= 2;
}
