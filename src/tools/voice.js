/**
 * `qq_voice`: say one line out loud — synthesize it and post it as a QQ voice
 * message.
 *
 * Nobody types `/语音` for this, so the tool has to be recognizable by what the
 * person asked for: 念一句, 发语音, 用语音回复我, 读给我听. The text comes from
 * the model (usually its own reply), and the audio is generated, saved and sent
 * in one call, so the turn does not have to hand a file around.
 *
 * Restricted to the owner, because every call spends money.
 */

/**
 * Register the voice tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {any} options.bridge The bridge.
 * @param {(line: string) => void} [options.log] Diagnostic sink.
 * @returns {() => void} Disposer.
 */
export function registerQqVoiceTool(ctx, options) {
  return ctx.tools.register({
    name: 'qq_voice',
    description:
      'Say something out loud as a QQ voice message (a 语音条, not text). Use it whenever the person asks to hear it — 「念一句…」「发语音」「用语音回复我」「读给我听」「念一下这段」— instead of writing the words in chat; no slash command is involved. Pass the exact line to speak in text: when they ask you to read your own reply, put that reply here. Keep it conversational and short (one to three sentences); long paragraphs are slow to synthesize and nobody listens to them. Each call costs the account owner money, so do not use it unasked and do not send both the text and the voice unless the person asked for both.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The exact words to speak, in the language the person used.' },
        voice_id: {
          type: 'string',
          description: 'Optional voice: stella (female, default) or tide (male). Defaults to the configured one.',
        },
      },
      required: ['text'],
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
        throw new Error('speaking is restricted to the administrator');
      }
      const text = String(args.text ?? '').trim();
      if (text === '') throw new Error('text is empty: say what should be spoken');

      const outcome = await bridge.speakForScene(context.scene, {
        text,
        voiceId: String(args.voice_id ?? ''),
      });
      await bridge.sendVoiceToScene(context.scene, outcome.path);
      options.log?.(`qq_voice ${context.scene}: ${outcome.bytes}B in ${outcome.ms}ms`);
      return {
        report: `念完了，${(outcome.ms / 1000).toFixed(1)}s，语音条已发。文件：${outcome.path}`,
        path: outcome.path,
        voiceId: outcome.voiceId,
        ms: outcome.ms,
      };
    },
  });
}
