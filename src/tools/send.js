/**
 * `qq_send`: post text, an image, or a file into the QQ conversation that
 * triggered this turn.
 *
 * The tool never accepts a destination: it always answers where it was asked.
 * Local attachments are admin-only, because a group member must not be able to
 * pull files off this machine by asking nicely.
 */

/** OneBot message segment, kept loose because the wire shape is per action. */
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
 * @param {object} options.bridge The bridge, for client access and session lookup.
 * @param {(line: string) => void} options.log Diagnostic sink.
 * @returns {() => void} Disposer.
 */
export function registerQqSendTool(ctx, options) {
  return ctx.tools.register({
    name: 'qq_send',
    description: 'Send something into the current QQ conversation: text, an image, or a file. Use it when the user asks you to "send me that", "发给我", or to post a result back into the chat. Only an administrator may attach a local image or file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Plain text to send, before any attachment.' },
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

      /** @type {Array<{ type: string, data: Record<string, unknown> }>} */
      const segments = [];
      if (typeof args.text === 'string' && args.text.trim() !== '') segments.push(textSegment(args.text));
      if (wantsImage) segments.push({ type: 'image', data: { file: toImageSource(args.image) } });

      const sent = [];
      if (segments.length > 0) {
        await bridge.client.call(action, { ...baseParams, message: segments }, { timeoutMs: 20_000 });
        sent.push(segments.map(segment => segment.type).join('+'));
      }
      if (wantsFile) {
        const upload = isGroup ? 'upload_group_file' : 'upload_private_file';
        const path = String(args.file);
        const name = path.split(/[\\/]/).pop() ?? 'file';
        await bridge.client.call(upload, { ...baseParams, file: path, name }, { timeoutMs: 60_000 });
        sent.push(`file:${name}`);
      }
      if (sent.length === 0) throw new Error('nothing to send: pass text, image, or file');

      options.log(`qq_send ${context.scene} -> ${sent.join(', ')}`);
      return {
        report: `已发送到 ${context.scene}：${sent.join('，')}`,
        scene: context.scene,
      };
    },
    presentCall: () => ({ card: 'generic', title: 'Send to QQ', kind: 'other', rawInput: {} }),
  });
}
