/**
 * `qq_send`: post text, an image, or a file into the QQ conversation that
 * triggered this turn.
 *
 * Two shapes, on purpose:
 *   - media without text  → sent immediately (evidence the person asked to see);
 *   - media with a caption → queued, then merged with the turn's reply so the
 *     picture and the conclusion arrive as one message instead of two.
 */

import { stat } from 'node:fs/promises';
import { captionOf } from '../bridge/outbox.js';
import { compressForUpload, disposeUploadCopy } from '../media/compress.js';

const textSegment = text => ({ type: 'text', data: { text } });

/**
 * Turn a path or URL into something OneBot accepts as an image source.
 *
 * @param {string} value Absolute path or http(s) URL.
 * @returns {string} A URL, or a `file:///` URI.
 */
export function toImageSource(value) {
  const raw = String(value).trim();
  if (/^https?:\/\//i.test(raw) || raw.startsWith('base64://')) return raw;
  const normalized = raw.replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file:///${normalized.replace(/^\/+/, '')}` : `file:///${normalized}`;
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
export function registerQqSendTool(ctx, options) {
  return ctx.tools.register({
    name: 'qq_send',
    description:
      'Send something into the current QQ conversation: text, an image, or a file. Use it when the user asks you to send/receive a file or a screenshot. With an image, the text is a caption: a short one reads as a label, and a long one is merged into this turn\'s reply (nothing is truncated, and a caption already inside the reply is not repeated). Local images/files are administrator only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Caption for the attachment; short labels read best, longer text is merged into the reply.' },
        image: { type: 'string', description: 'Absolute path or http(s) URL of an image to send. Admin only.' },
        file: { type: 'string', description: 'Absolute path of a file to upload. Admin only.' },
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

      const wantsImage = typeof args.image === 'string' && args.image !== '';
      const wantsFile = typeof args.file === 'string' && args.file !== '';
      if ((wantsImage || wantsFile) && context.tier !== 'owner') {
        throw new Error('attachments are restricted to the administrator');
      }

      const isGroup = context.scene.startsWith('group:');
      const targetId = Number(context.scene.slice(context.scene.indexOf(':') + 1));
      const action = isGroup ? 'send_group_msg' : 'send_private_msg';
      const baseParams = isGroup ? { group_id: targetId } : { user_id: targetId };

      // A 9 MB PNG takes seconds to upload; the same frame as JPEG is under 1 MB.
      // The local original is untouched, so a later read_image still sees full detail.
      let imagePath = wantsImage ? String(args.image) : '';
      let temporaryCopy = '';
      if (wantsImage && !/^(https?:\/\/|base64:\/\/)/i.test(imagePath)) {
        const info = await stat(imagePath).catch(() => undefined);
        if (info !== undefined) {
          const upload = await compressForUpload(imagePath, { size: info.size, log: options.log });
          imagePath = upload.path;
          if (upload.converted) temporaryCopy = upload.path;
        }
      }

      const caption = captionOf(args.text);
      // A captioned picture is part of the answer: hold it for the reply.
      if ((wantsImage || wantsFile) && caption.text !== '') {
        bridge.queueMedia(context.scene, {
          caption: caption.text,
          image: imagePath,
          file: wantsFile ? String(args.file) : '',
        });
        options.log(`qq_send queued ${context.scene} (caption ${caption.text.length} chars)`);
        return {
          report: `已排到本轮回复里一起发送（说明会与正文合并，不截断）`,
          scene: context.scene,
          queued: true,
        };
      }

      /** @type {Array<{ type: string, data: Record<string, unknown> }>} */
      const segments = [];
      if (typeof args.text === 'string' && args.text.trim() !== '') segments.push(textSegment(args.text));
      if (wantsImage) segments.push({ type: 'image', data: { file: toImageSource(imagePath) } });

      const sent = [];
      if (segments.length > 0) {
        await bridge.client.call(action, { ...baseParams, message: segments }, { timeoutMs: 20_000 });
        sent.push(segments.map(segment => segment.type).join('+'));
        bridge.recordSceneOutbound?.(context.scene, String(args.text ?? '').trim() || '[图片]', wantsImage ? 'image' : undefined);
      }
      if (wantsFile) {
        const upload = isGroup ? 'upload_group_file' : 'upload_private_file';
        const path = String(args.file);
        const name = path.split(/[\\/]/).pop() ?? 'file';
        await bridge.client.call(upload, { ...baseParams, file: path, name }, { timeoutMs: 60_000 });
        sent.push(`file:${name}`);
        bridge.recordSceneOutbound?.(context.scene, `[文件] ${name}`, 'file');
      }
      if (sent.length === 0) throw new Error('nothing to send: pass text, image, or file');

      if (temporaryCopy !== '') await disposeUploadCopy(temporaryCopy);
      options.log(`qq_send ${context.scene} -> ${sent.join(', ')}`);
      return {
        report: `已发送到 ${context.scene}：${sent.join('，')}`,
        scene: context.scene,
      };
    },
    presentCall: () => ({ card: 'generic', title: 'Send to QQ', kind: 'other', rawInput: {} }),
  });
}
