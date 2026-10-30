/**
 * `sticker_send`: post one of the account's own QQ stickers (收藏表情).
 *
 * Sending goes through the transport's dedicated `send_custom_face` action,
 * which puts an `image` element with `sub_type: 1` on the wire — QQ renders that
 * as a 动画表情, not as a photo. Building an `mface` segment by hand does not
 * work for custom faces (QQ rejects it), which is why this tool exists.
 *
 * The model decides whether a sticker fits; this tool only enforces the limits
 * the bridge cannot leave to the model: the sticker must exist, and one scene
 * may not receive more than the configured number per hour.
 */

import { findStickers, stickerHandle } from '../stickers/catalog.js';

/**
 * Register the sticker tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {any} options.bridge The bridge.
 * @returns {() => void} Disposer.
 */
export function registerStickerTool(ctx, options) {
  return ctx.tools.register({
    name: 'sticker_send',
    description:
      'Send one QQ sticker (收藏表情) into the current conversation. Use it only when a sticker genuinely fits the mood — a joke landed, someone is venting, a casual hello. Do not send one when the conversation is serious, when someone asked you to stop, or when you already sent one this turn. Pass a short handle from the catalog, or a few keywords describing the sticker.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sticker: {
          type: 'string',
          description: 'Handle from the sticker catalog (6 hex chars) or a keyword such as "笑" / "无语".',
        },
      },
      required: ['sticker'],
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
      if (bridge.stickers === undefined) throw new Error('the sticker library is not loaded');

      if (bridge.stickers.isMuted(context.scene)) {
        throw new Error('this conversation asked for no stickers; do not send one');
      }
      const library = bridge.stickers.all();
      if (library.length === 0) throw new Error('the sticker library is empty; sync it from the settings page first');

      const matches = findStickers(library, args.sticker);
      if (matches.length === 0) {
        const sample = library.slice(0, 8).map(sticker => `${stickerHandle(sticker)} ${sticker.desc || '（无描述）'}`).join('；');
        throw new Error(`no sticker matches "${String(args.sticker)}". Available for example: ${sample}`);
      }
      const sticker = matches[0];

      const budget = bridge.stickerBudget(context.scene);
      if (budget.allowed !== true) {
        throw new Error(`this conversation already got ${budget.sent} stickers in the last hour; send none now`);
      }

      const isGroup = context.scene.startsWith('group:');
      const target = Number(context.scene.slice(context.scene.indexOf(':') + 1));
      // Prefer the small local preview with sticker flags: QQ renders a remote
      // original at full size, so the bubble looked like a photo instead of a
      // face. Fall back to the transport's own custom-face action when no
      // preview was downloaded yet.
      const source = typeof bridge.stickerImageSource === 'function' ? bridge.stickerImageSource(sticker) : '';
      if (source !== '') {
        await bridge.client.call(isGroup ? 'send_group_msg' : 'send_private_msg', {
          ...(isGroup ? { group_id: target } : { user_id: target }),
          message: [{ type: 'image', data: { file: source, sub_type: 1, summary: '[动画表情]' } }],
        }, { timeoutMs: 20_000 });
      } else {
        await bridge.client.call('send_custom_face', {
          emoji_id: sticker.md5,
          ...(isGroup ? { group_id: target } : { user_id: target }),
        }, { timeoutMs: 20_000 });
      }

      bridge.noteStickerSent(context.scene, sticker);
      options.log?.(`sticker sent to ${context.scene}: ${stickerHandle(sticker)} ${sticker.desc}`);
      return {
        report: `已发送表情包（${stickerHandle(sticker)} ${sticker.desc || '无描述'}）。这一轮不要再发表情。`,
        sticker: stickerHandle(sticker),
      };
    },
  });
}

