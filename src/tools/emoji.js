/**
 * `emoji_send`: post one of QQ's built-in faces (小黄脸).
 *
 * These are not the account's stickers: a `face` segment with an integer id is
 * all QQ needs, so they work even before the sticker library has synced. The
 * same "do not send when they asked you not to" rule applies.
 */

import { findFace } from '../stickers/faces.js';

/**
 * Register the built-in face tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {any} options.bridge The bridge.
 * @returns {() => void} Disposer.
 */
export function registerEmojiTool(ctx, options) {
  return ctx.tools.register({
    name: 'emoji_send',
    description:
      'Send one QQ built-in face (小黄脸), such as 微笑, 呲牙, 狗头, 白眼, 鼓掌. Use a name from the list or a numeric face id. Only send when it genuinely fits the mood; never when the conversation is serious or the other side asked for no stickers/faces.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        emoji: {
          type: 'string',
          description: 'Face name (微笑 / 狗头 / 白眼) or a numeric QQ face id.',
        },
      },
      required: ['emoji'],
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
      if (bridge.stickers?.isMuted(context.scene) === true) {
        throw new Error('this conversation asked for no stickers or faces; do not send one');
      }

      const face = findFace(args.emoji);
      if (face === undefined) throw new Error(`unknown face "${String(args.emoji)}"; use a name from the list or a numeric id`);

      const isGroup = context.scene.startsWith('group:');
      const target = Number(context.scene.slice(context.scene.indexOf(':') + 1));
      await bridge.client.call(isGroup ? 'send_group_msg' : 'send_private_msg', {
        ...(isGroup ? { group_id: target } : { user_id: target }),
        message: [{ type: 'face', data: { id: face.id } }],
      }, { timeoutMs: 15_000 });

      bridge.noteFaceSent(context.scene);
      options.log?.(`face ${face.id} (${face.name}) sent to ${context.scene}`);
      return { report: `已发送 QQ 表情「${face.name}」（id ${face.id}）。这一轮不要再发表情。`, face: face.id };
    },
  });
}
