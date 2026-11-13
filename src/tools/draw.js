/**
 * `qq_draw`: draw a picture with the configured image provider and post it here.
 *
 * The picture is not a file the model has to shuttle around: generation, saving
 * and sending happen in one call, so a conversation can answer "画一只猫" with
 * the cat itself. Restricted to the owner, because every call spends money on
 * an account the administrator configured.
 */

/**
 * Register the drawing tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {any} options.bridge The bridge.
 * @param {(line: string) => void} [options.log] Diagnostic sink.
 * @returns {() => void} Disposer.
 */
export function registerQqDrawTool(ctx, options) {
  return ctx.tools.register({
    name: 'qq_draw',
    description:
      'Draw one picture with the configured image model (火山方舟 Seedream by default) and send it into the current QQ conversation. Use it whenever someone asks for a picture — "生成一张鲸鱼娘在喝奶茶，真人cos", "画个猫", "给我张壁纸" — instead of describing what the picture would look like, and use it for edits too: "修改这张图片，人物换成真人cos" needs no path, because the picture they quoted or sent with the request is used (the newest picture in the chat only when neither exists); pass image for a file that is not in the conversation at all. Generation takes several seconds and costs the account owner money, so only draw when asked.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'What the picture should show, in the language the person used.' },
        size: {
          type: 'string',
          description: 'Optional size the provider accepts, such as 1024x1024, 1536x1024 or 2K. Defaults to the configured one.',
        },
        image: {
          type: 'string',
          description: 'Optional absolute path of a local picture to edit (图生图); the result keeps its composition.',
        },
      },
      required: ['prompt'],
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
        throw new Error('drawing is restricted to the administrator');
      }
      const prompt = String(args.prompt ?? '').trim();
      if (prompt === '') throw new Error('prompt is empty: say what the picture should show');

      // "把这张换成真人 cos" names no file: the picture they mean is the last one
      // they sent, and the bridge can find it in the archive by itself.
      const edit = /(?:修改|改成|换成|替换|把这张|这张图|改一下|修图|转成)/.test(prompt);
      const outcome = await bridge.drawForScene(context.scene, {
        prompt,
        size: String(args.size ?? ''),
        imagePath: String(args.image ?? ''),
        edit,
      });
      await bridge.sendImageToScene(context.scene, outcome.path, '');
      options.log?.(`qq_draw ${context.scene}: ${outcome.bytes}B in ${outcome.ms}ms`);
      return {
        report: `画好了，${(outcome.ms / 1000).toFixed(1)}s，已发到聊天里。文件：${outcome.path}`,
        path: outcome.path,
        model: outcome.model,
        size: outcome.size,
        ms: outcome.ms,
      };
    },
  });
}
