/**
 * `qq_ask`: put a question to the person in QQ and return at once.
 *
 * The agent-facing `ask_user_question` tool blocks the whole turn until its
 * window dialog is answered, and a QQ reply cannot reach that dialog while it
 * waits. This tool deliberately does not wait: it posts the question, ends, and
 * the person's reply arrives as the next ordinary message.
 */

const LETTERS = 'abcdefghij';

/**
 * Render the question the way it will read in QQ.
 *
 * @param {string} question The question text.
 * @param {string[]} choices Optional choices.
 * @returns {string} The message body.
 */
function renderAsk(question, choices) {
  const lines = [`【问你】${question.trim()}`];
  choices.forEach((choice, index) => {
    lines.push(`${LETTERS[index] ?? String(index + 1)}. ${choice}`);
  });
  if (choices.length > 0) {
    lines.push('（回一个字母就行，也可以直接说你的答案）');
  }
  return lines.join('\n');
}

/**
 * Register the tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {any} options.bridge The bridge.
 * @param {(line: string) => void} options.log Diagnostic sink.
 * @returns {() => void} Disposer.
 */
export function registerQqAskTool(ctx, options) {
  return ctx.tools.register({
    name: 'qq_ask',
    description:
      'Ask the person a question in the current QQ conversation and return immediately. Unlike ask_user_question this never blocks the turn and never opens a window dialog: the question is posted to QQ, and their reply arrives as the next ordinary message.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'What to ask, in one sentence.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional choices, letters are assigned automatically.',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args = {}, exec) {
      const bridge = options.bridge;
      const sessionId = String(exec?.agent?.id ?? '');
      const context = bridge.sessionContext(sessionId);
      if (context === undefined) throw new Error('this session is not bound to a QQ conversation');
      if (bridge.client === undefined) throw new Error('the QQ transport is not connected');

      const question = String(args.question ?? '').trim();
      if (question === '') throw new Error('nothing to ask: pass question');
      const choices = Array.isArray(args.options) ? args.options.map(item => String(item)) : [];
      const text = renderAsk(question, choices);

      const isGroup = context.scene.startsWith('group:');
      const targetId = Number(context.scene.slice(context.scene.indexOf(':') + 1));
      const action = isGroup ? 'send_group_msg' : 'send_private_msg';
      const baseParams = isGroup ? { group_id: targetId } : { user_id: targetId };
      await bridge.client.call(action, { ...baseParams, message: [{ type: 'text', data: { text } }] }, { timeoutMs: 20_000 });
      bridge.recordSceneOutbound?.(context.scene, text);
      options.log(`qq_ask ${context.scene} (${question.length} chars)`);
      return { report: `已发到 ${context.scene}，不等回复：他答了会作为下一条消息进来。`, scene: context.scene, asked: true };
    },
    presentCall: () => ({ card: 'generic', title: 'Ask on QQ', kind: 'other', rawInput: {} }),
  });
}
