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
      'Say something out loud as a QQ voice message (a 语音条, not text). Use it whenever the person asks to hear it — 「念一句…」「发语音」「用语音回复我」「读给我听」「念一下这段」— instead of writing the words in chat; no slash command is involved. Pass the exact line to speak in text: when they ask you to read your own reply, put that reply here. Write it the way it should sound — short spoken clauses, real punctuation, 语气词 — because the engine has no emotion setting and the words are the only lever; the bridge strips Markdown, splits long sentences and shapes the closing punctuation for you, so do not add stage directions like "（小声）". Keep it to one to three sentences; long paragraphs are slow to synthesize and nobody listens to them. The voice may come from this machine (the Feiyu engine, when the local voice switch is on — slower, but no per-sentence bill) or from the hosted DeepSeek voice, which costs the account owner money; either way do not use it unasked and do not send both the text and the voice unless the person asked for both.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The exact words to speak, in the language the person used.' },
        tone: {
          type: 'string',
          description: 'Optional delivery hint: 开心 / 难过 / 生气 (or cheer, sad, angry). Only bends the closing punctuation; leave it out to keep the tone the words already carry.',
        },
        voice_id: {
          type: 'string',
          description: 'Optional voice: stella (female, default) or tide (male). Defaults to the configured one. Only used when her local voice is not available.',
        },
        style: {
          type: 'string',
          enum: ['cute', 'gentle'],
          description: 'Optional local voice style: cute (可爱) or gentle (温柔). Defaults to the configured one; ignored by the hosted voice.',
        },
        emotion: {
          type: 'string',
          enum: [
            'happy', 'excited', 'angry', 'sad', 'crying', 'coquettish', 'shy', 'scared',
            'tired', 'teasing', 'contempt', 'serious', 'sigh',
            'soft', 'loud', 'slow', 'fast', 'sichuan', 'cantonese', 'northeast',
          ],
          description: 'Optional emotion for the local Feiyu voice: happy 开心, excited 兴奋, angry 生气, sad 委屈/难过, crying 哭腔, coquettish 撒娇, shy 害羞, scared 害怕, tired 累, teasing 调侃/挑衅, contempt 不屑, serious 严肃, sigh 叹气, soft 轻声, loud 大声, slow 慢, fast 快, sichuan 四川话, cantonese 广东话, northeast 东北话. Only the local CosyVoice3 voice honours it.',
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
        tone: String(args.tone ?? ''),
        voiceId: String(args.voice_id ?? ''),
        style: String(args.style ?? ''),
        emotion: String(args.emotion ?? ''),
      });
      await bridge.sendVoiceToScene(context.scene, outcome.path);
      options.log?.(`qq_voice ${context.scene}: ${outcome.bytes}B in ${outcome.ms}ms via ${outcome.provider}`);
      const voice = outcome.provider === 'feiyu-tts'
        ? '肥鱼（她自己的声音）'
        : outcome.provider === 'feiyu-rvc'
          ? '肥鱼（原声 + RVC 变声）'
          : '原声（DeepSeek）';
      return {
        report: `念完了，${(outcome.ms / 1000).toFixed(1)}s，${voice}，语音条已发。文件：${outcome.path}${outcome.note === '' ? '' : `\n${outcome.note}`}`,
        path: outcome.path,
        voiceId: outcome.voiceId,
        provider: outcome.provider,
        ms: outcome.ms,
      };
    },
  });
}
