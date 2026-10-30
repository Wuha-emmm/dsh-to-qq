/**
 * Periodic "record one impression" nudge.
 *
 * Every N answered turns the bridge asks the model, inside that turn's prompt,
 * to write down one fact it learned — the alternative is a private model call,
 * which costs a whole turn and its own context.
 */

/** Default cadence in turns; 0 disables the nudge. */
export const DEFAULT_AUTO_NOTE_EVERY = 8;

/**
 * Whether this turn is one where the nudge belongs.
 *
 * @param {number} turnNumber 1-based count of answered turns for the sender.
 * @param {number} every Cadence; 0 or negative disables.
 * @returns {boolean} True when the reminder should be appended.
 */
export function dueForAutoNote(turnNumber, every) {
  const cadence = Math.floor(Number(every) || 0);
  if (cadence <= 0) return false;
  if (!Number.isInteger(turnNumber) || turnNumber <= 0) return false;
  return turnNumber % cadence === 0;
}

/**
 * The reminder itself. Deliberately discouraging invented notes.
 *
 * @returns {string} A line to append to the prompt.
 */
export function autoNotePrompt() {
  return '\n\n（本轮附加要求：如果最近的聊天里出现了值得长期记住的新事实，调用 memory_note 记一条，一句话、只记事实。'
    + '没有新事实就不要记，也别把「说话要简短」这类要求写进笔记——那是人设。）';
}
