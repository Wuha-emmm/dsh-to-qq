/**
 * `qq_voice_service`: the switch for her own voice.
 *
 * The local engine is a separate installation that loads gigabytes of weights
 * per job, so "turn it off" has to mean more than a boolean in a config file:
 * this tool also stops the queue process and reports what the installation can
 * actually do right now.
 */

/**
 * Register the service-control tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {any} options.bridge The bridge (exposes `localVoice`).
 * @param {(line: string) => void} [options.log] Diagnostic sink.
 * @returns {() => void} Disposer.
 */
export function registerQqVoiceServiceTool(ctx, options) {
  return ctx.tools.register({
    name: 'qq_voice_service',
    description:
      'Inspect, start or stop the local Feiyu voice that gives qq_voice her own voice. Use action "status" before claiming the local voice is on or off, "stop" when the person says to shut the local voice down (it kills the resident engine and releases its VRAM, and any queued job dies), and "start" to bring it back. Stopping does not uninstall anything: with it stopped — or with the switch off in settings — qq_voice falls back to the hosted DeepSeek voice.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop'], description: 'What to do; defaults to status.' },
      },
      required: [],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args = {}) {
      const bridge = options.bridge;
      const local = bridge.localVoice;
      if (local === undefined) throw new Error('本地声音模块没有接上（插件版本太旧？）');
      const action = String(args.action ?? 'status');
      if (action === 'start') {
        if (local.enabled() === false) {
          throw new Error('开关是关的：先在设置里勾上「启用本地肥鱼声音」，或者在 config.json 里把 speech.local.enabled 设成 true。');
        }
        await local.start();
      } else if (action === 'stop') {
        const warm = local.warmEnabled() === true;
        const stopped = await local.stop();
        return {
          report: stopped.stopped
            ? `${warm ? '常驻进程' : '本地声音服务'}已退出，GPU 和排队任务都放掉了。语音会回落到原声。`
            : `${warm ? '常驻进程' : '本地声音服务'}本来就没在运行（可能是手动启动的，或者开关没开）。`,
          stopped: stopped.stopped,
        };
      }
      const status = await local.status();
      options.log?.(`qq_voice_service ${action}: mode=${status.mode} healthy=${status.healthy} tts=${status.tts} rvc=${status.rvc}`);
      const warm = status.warm;
      const ttsWarm = status.ttsWarm;
      const lines = [
        `开关：${status.enabled ? '开' : '关'}`,
        `模式：${status.mode === 'warm' ? '常驻预热（变声每句约 0.2 秒）' : '按句起进程（每句约 10 秒）'}`,
        warm === undefined
          ? `服务：${status.healthy ? `在跑（${status.version || '?'}）` : `没起来${status.error === '' ? '' : `：${status.error}`}`}`
          : `变声进程：${warm.ready ? `已加载（${(warm.loadMs / 1000).toFixed(1)}s 预热 ${(warm.prewarmMs / 1000).toFixed(1)}s，${warm.device || '?'}）` : '没在运行'}`
            + `${warm.ready ? `，显存约 ${warm.gpuMb} MB / 内存约 ${warm.rssMb} MB` : ''}`,
        ttsWarm === undefined
          ? `本地 TTS：设置里没开`
          : `本地 TTS：${ttsWarm.ready ? `已加载（${(ttsWarm.loadMs / 1000).toFixed(1)}s 预热 ${(ttsWarm.prewarmMs / 1000).toFixed(1)}s，${ttsWarm.device || '?'}，${ttsWarm.style}）` : ttsWarm.enabled ? '没在运行（用到时会自动加载）' : '设置里没开'}`
            + `${ttsWarm.ready ? `，显存约 ${ttsWarm.gpuMb} MB / 内存约 ${ttsWarm.rssMb} MB，最近一句 ${(ttsWarm.lastMs / 1000).toFixed(1)}s` : ''}`,
        `引擎：TTS ${status.tts ? '可用' : '不可用'} / RVC ${status.rvc ? '可用' : '不可用'}${status.styles.length === 0 ? '' : `（风格：${status.styles.join('、')}）`}`,
        `空闲自动停：${status.idleStopMinutes === 0 ? '不自动停' : `${status.idleStopMinutes} 分钟`}`,
        `最近一句：${status.lastKind === '' ? '还没念过' : `${status.lastKind === 'tts' ? '她的声音' : '变声'}，${(status.lastMs / 1000).toFixed(1)}s`}`,
        `目录：${status.serverRoot || local.root() || '未配置'}`,
      ];
      if (status.lastError !== '') lines.push(`上次错误：${status.lastError}`);
      return { report: lines.join('\n'), status };
    },
  });
}
