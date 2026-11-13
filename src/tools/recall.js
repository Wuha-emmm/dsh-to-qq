/**
 * `qq_recall`: take back the bridge's own most recent message(s).
 *
 * QQ lets an account recall what it posted (a bot may do so for its own
 * messages), so withdrawing a sentence that came out wrong needs no app restart
 * and no manual long-press. Only our side is ever recalled: the ids come from
 * outbound rows of the archive, never from what other people said.
 */

/**
 * Register the recall tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {any} options.bridge The bridge.
 * @param {(line: string) => void} [options.log] Diagnostic sink.
 * @returns {() => void} Disposer.
 */
export function registerQqRecallTool(ctx, options) {
  return ctx.tools.register({
    name: 'qq_recall',
    description:
      'Recall (撤回/delete) the most recent message(s) this bridge posted into the current QQ conversation. Use it when the person asks you to take back something you just sent, or when you posted the wrong thing. Only your own messages can be recalled, newest first; QQ refuses messages that are too old, so this works best within a couple of minutes. A message that already left as a picture or a file counts as one message.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        count: {
          type: 'integer',
          description: 'How many of the newest messages to recall, 1 to 10. Defaults to 1.',
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
      if (context.tier !== 'owner' && context.tier !== 'owner-group') {
        throw new Error('recalling messages is restricted to the administrator');
      }
      if (bridge.client === undefined) throw new Error('the QQ transport is not connected');

      const count = Math.min(10, Math.max(1, Number(args.count) || 1));
      const outcome = await bridge.recallLast(context.scene, count);
      options.log?.(`qq_recall ${context.scene}: ${outcome.recalled} ok, ${outcome.failed} failed`);

      if (outcome.recalled === 0 && outcome.failed === 0) {
        throw new Error('there is no message of ours left in this conversation that can be recalled');
      }
      return {
        report: outcome.failed === 0
          ? `已撤回 ${outcome.recalled} 条。`
          : `撤回 ${outcome.recalled} 条，${outcome.failed} 条没成功（多半是太旧了）。`,
        recalled: outcome.recalled,
        failed: outcome.failed,
        scene: context.scene,
      };
    },
  });
}
