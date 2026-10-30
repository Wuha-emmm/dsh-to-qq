/**
 * Decide whether a turn's text should be sent at all.
 *
 * Sending a card is the whole answer: anything the model adds afterwards is
 * noise, no matter how long it is. Failures take a different path — the tool
 * throws, no card is counted, and the text (or the fallback) goes out normally.
 */

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
