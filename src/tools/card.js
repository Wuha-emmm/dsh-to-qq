/**
 * `memory_card_send`: render this conversation's memory card and post it.
 *
 * The slash command `/记忆卡` exists for people who know it, but "把记忆卡发我"
 * is what a human actually types — this tool lets the model answer that.
 */

/**
 * Register the tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {object} options.bridge The bridge: client, session lookup, memory, media dir.
 * @param {object} options.store Live configuration.
 * @param {(line: string) => void} options.log Diagnostic sink.
 * @returns {() => void} Disposer.
 */
export function registerMemoryCardTool(ctx, options) {
  return ctx.tools.register({
    name: 'memory_card_send',
    description: 'Render the memory card of the person you are talking to (or a QQ number the administrator names) and send it into this chat as an image. Use it when they ask to see their memory card, 人设卡, or 档案. The image is the answer: do not announce the send in your reply, and stay silent after a successful call unless something failed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        qq: { type: 'number', description: 'Optional QQ number; administrators only. Defaults to the current speaker.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args = {}, exec) {
      const bridge = options.bridge;
      const info = bridge.sessionContext(String(exec?.agent?.id ?? ''));
      if (info === undefined) throw new Error('this session is not bound to a QQ conversation');
      if (bridge.client === undefined) throw new Error('the QQ transport is not connected');

      const requested = Number(args.qq);
      const target = Number.isInteger(requested) && requested > 0 ? requested : info.qq;
      if (target !== info.qq && info.tier !== 'owner') {
        throw new Error('only the administrator may ask for someone else\'s card');
      }

      const card = bridge.memory?.get(target);
      if (card === undefined) throw new Error('that person has no memory card yet');

      const { renderMemoryCard } = await import('../render/memory-card.js');
      const { sceneLabelFor, resolveName } = await import('../bridge/labels.js');
      const name = await resolveName(bridge, target, card.name, info.scene);
      const payload = await renderMemoryCard({
        qq: target,
        name,
        persona: card.persona?.text ?? '',
        // The image path is the last line of defence: a note that slipped into
      // storage still must not be drawn.
      notes: filterNotes(card.notes ?? []).notes,
        admin: options.store.get().access.admins.some(admin => admin.qq === target),
        sceneLabel: await sceneLabelFor(bridge.client, info.scene),
      }, { log: options.log, backdropDir: bridge.mediaDir });

      const inGroup = info.scene.startsWith('group:');
      const id = Number(info.scene.slice(info.scene.indexOf(':') + 1));
      await bridge.client.call(
        inGroup ? 'send_group_msg' : 'send_private_msg',
        inGroup
          ? { group_id: id, message: [{ type: 'image', data: { file: payload } }] }
          : { user_id: id, message: [{ type: 'image', data: { file: payload } }] },
        { timeoutMs: 30_000 },
      );
      bridge.recordSceneOutbound?.(info.scene, `[图片] 记忆卡 ${target}`, 'image');
      bridge.noteCardSent?.();
      options.log(`memory card sent to ${info.scene} for ${target}`);
      return { report: `已把 ${target} 的记忆卡发到聊天里。`, qq: target };
    },
    presentCall: () => ({ card: 'generic', title: 'Send memory card', kind: 'other', rawInput: {} }),
  });
}


