/**
 * Bridge between DSH's `ask_user_question` cards and QQ text replies.
 *
 * The Host blocks the agent until someone answers; on QQ nobody can click, so
 * the bridge forwards the questions as numbered text and accepts a number, an
 * option label, or free text as the answer.
 */

/**
 * Render one pending question batch as a QQ-readable list.
 *
 * @param {ReadonlyArray<{ id: string, question: string, header?: string, options?: Array<{ label: string, description?: string }>, multiSelect?: boolean }>} questions Questions.
 * @returns {string} Message body.
 */
export function describeQuestions(questions) {
  const lines = ['需要你拍板：'];
  for (const [index, question] of questions.entries()) {
    if (question.header !== undefined) lines.push(`【${question.header}】`);
    lines.push(`${index + 1}. ${question.question}`);
    const options = Array.isArray(question.options) ? question.options : [];
    for (const [optionIndex, option] of options.entries()) {
      const suffix = option.description === undefined ? '' : ` —— ${option.description}`;
      lines.push(`   ${String.fromCharCode(97 + optionIndex)}. ${option.label}${suffix}`);
    }
    if (options.length > 1) lines.push(`   回 ${index + 1}a / ${index + 1}b … 选一个，或多选时写 ${index + 1}ab`);
  }
  lines.push('（也可以直接回一句你自己的答案）');
  return lines.join('\n');
}

/**
 * Turn one QQ reply into the structured answer batch the Host expects.
 *
 * @param {string} text The user's message.
 * @param {ReadonlyArray<{ id: string, options?: Array<{ label: string }>, multiSelect?: boolean }>} questions The pending questions.
 * @returns {{ answers: Array<{ id: string, selected: string[], custom?: string }> } | undefined} The batch, or undefined when the reply is not an answer.
 */
export function parseReply(text, questions) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '' || questions.length === 0) return undefined;

  /** @type {Array<{ id: string, selected: string[], custom?: string }>} */
  const answers = [];
  for (const [index, question] of questions.entries()) {
    const options = Array.isArray(question.options) ? question.options : [];
    const labelled = options.find(option => option.label === trimmed);
    if (labelled !== undefined) {
      answers.push({ id: question.id, selected: [labelled.label] });
      continue;
    }
    // `1a`, `2b`, `1ab` — question number then option letters.
    const match = /^(\d+)([a-z]+)$/i.exec(trimmed);
    if (match !== null && Number(match[1]) === index + 1) {
      const letters = match[2].toLowerCase().split('');
      const picked = letters
        .map(letter => options[letter.charCodeAt(0) - 97])
        .filter(option => option !== undefined)
        .map(option => option.label);
      if (picked.length > 0) {
        answers.push({ id: question.id, selected: question.multiSelect === true ? picked : [picked[0]] });
        continue;
      }
    }
    // A bare number answers the first (or only) question.
    if (questions.length === 1 && /^\d+$/.test(trimmed)) {
      const picked = options[Number(trimmed) - 1];
      if (picked !== undefined) {
        answers.push({ id: question.id, selected: [picked.label] });
        continue;
      }
    }
  }

  if (answers.length === questions.length) return { answers };
  // Free text: attach it to the first question that takes custom input.
  if (questions.length === 1) {
    return { answers: [{ id: questions[0].id, selected: [], custom: trimmed }] };
  }
  return { answers: questions.map(question => ({ id: question.id, selected: [], custom: trimmed })) };
}

/**
 * Pull pending questions out of whatever shape the projection snapshot has.
 *
 * @param {any} snapshot Result of `sessionController.projections(...)` or similar.
 * @returns {Array<{ callId: string, questions: any[], state?: string }>} Pending batches.
 */
export function extractPending(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return [];
  const candidate = snapshot.pendingQuestions
    ?? snapshot.pending_questions
    ?? snapshot['pending-questions']
    ?? (snapshot.projections === undefined ? undefined : snapshot.projections.pendingQuestions);
  if (!Array.isArray(candidate)) return [];
  return candidate
    .filter(item => item !== null && typeof item === 'object' && Array.isArray(item.questions) && typeof item.callId === 'string')
    .map(item => ({ callId: item.callId, questions: item.questions, state: item.state }));
}
