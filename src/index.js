/**
 * dsh-to-qq — QQ <-> DeepSeek Harness bridge (Host half).
 *
 * v0.3: the owner's private chat drives a real DSH session, groups answer from a
 * bounded context window, and every non-owner tier is confined by a tool
 * allowlist installed on its own agent context at creation time.
 *
 * @module dsh-to-qq
 */

import { dirname, join } from 'node:path';
import { ConfigStore, defaultConfigPath } from './config/store.js';
import { mergeConfig } from './config/defaults.js';
import { mergeIncomingConfig } from './config/merge.js';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { pickRoute } from './llm/route.js';
import { estimateCost, cacheRate } from './llm/cost.js';
import { panelAccess } from './web/guard.js';
import { pruneMedia } from './media/prune.js';
import { detectMediaType } from './media/inbound.js';
import { StickerStore } from './stickers/store.js';
import { describePrompt, parseAnalysis, DESCRIBE_SYSTEM } from './stickers/describe.js';
import { registerStickerTool } from './tools/stickers.js';
import { registerEmojiTool } from './tools/emoji.js';
import { registerPageTool } from './tools/page.js';
import { registerBilibiliTool } from './tools/bilibili.js';
import { AccountStore } from './accounts/store.js';
import { verifyLogin } from './accounts/bilibili.js';
import { findBrowser, launchBrowser, readBrowserCookies, cookieHeaderFrom, hasBilibiliSession } from './accounts/browser.js';
import { Bridge } from './bridge/runtime.js';
import { DshDriver, SessionMap } from './bridge/sessions.js';
import { ensureSnowLuma } from './bridge/snowluma.js';
import { GuestRegistry, installTierRestriction } from './policy/restrictions.js';
import { MemoryStore } from './memory/store.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerQqSendTool } from './tools/send.js';
import { registerMemoryCardTool } from './tools/card.js';
import { registerDigestTool } from './tools/digest.js';
import { openArchive } from './archive/db.js';
import { PetClient } from './pet/client.js';
import { Approvals, DANGEROUS_TOOLS } from './policy/approvals.js';

/** Required services: tools, the session driver, and the HTTP carrier for the panel. */
export const inject = ['tools', 'sessionController', 'webServer'];

/** Reported by `qq_status` and by the panel endpoint, so a stale host is visible. */
const VERSION = '0.74.0';

/** @type {ConfigStore | undefined} */
let shared;

/**
 * Read the process-wide config store, creating it on first use.
 *
 * @param {(error: Error) => void} [onError] Error sink.
 * @returns {ConfigStore} The shared store.
 */
export function configStore(onError) {
  shared ??= new ConfigStore(defaultConfigPath(), onError);
  return shared;
}

/**
 * Register the bridge.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx The plugin context.
 */
export function apply(ctx) {
  const log = line => console.log(`[dsh-to-qq] ${line}`);
  const store = configStore(error => log(`config: ${error.message}`));
  const stateDir = dirname(store.file);
  const map = new SessionMap(join(stateDir, 'sessions.json'));
  const accounts = new AccountStore(join(stateDir, 'accounts.json'));
  const browserProfile = join(stateDir, 'browser-profile');
  void accounts.load().catch(error => log(`accounts load failed: ${error.message}`));
  const guestStore = new SessionMap(join(stateDir, 'guests.json'));
  const guests = new GuestRegistry();
  const memory = new MemoryStore(join(stateDir, 'memory.json'));
  const stickerDir = join(stateDir, 'media', 'stickers');
  const stickers = new StickerStore(join(stateDir, 'stickers.json'), stickerDir);
  /** Last image-admission failure, surfaced by `qq_status` for diagnosis. */
  let lastImageError = '';
  /** Event types seen during turns, so unknown shapes can be identified. */
  const eventTypes = new Set();
  const driver = new DshDriver({
    chooseModel: async tier => {
      const catalog = await ctx.sessionController.modelCatalog();
      const settings = tier === 'owner' ? store.get().models.owner : store.get().models.member;
      const route = pickRoute(catalog, settings);
      return route.provider === '' || route.model === '' ? undefined : route;
    },
    controller: ctx.sessionController,
    // Rebuilding hides the replaced session instead of leaving a new sidebar row.
    archiveSession: async sessionId => {
      const registry = ctx.get('workspaceRegistry');
      if (registry === undefined || typeof registry.archiveSession !== 'function') return;
      await registry.archiveSession(sessionId);
    },
    applyPermission: async sessionId => {
      const preset = store.get().models.permissionPreset;
      if (appliedPermissions.get(sessionId) === preset) return;
      if (typeof preset !== 'string' || preset === '') return;
      const presets = ctx.get('permissionPresets');
      if (presets === undefined || typeof presets.set !== 'function') return;
      // The write path needs a live Session; resolveAgent resumes one on demand.
      const resolved = await ctx.sessionController.resolveAgent(sessionId).catch(() => undefined);
      const agent = resolved?.agent ?? ctx.get('agents')?.get?.(sessionId);
      if (agent === undefined) return;
      if (presets.current?.(agent.session) === preset) return;
      presets.set(agent.session, preset);
      appliedPermissions.set(sessionId, preset);
      log(`permission preset ${preset} applied to ${sessionId}`);
    },
    map,
    guests,
    guestStore,
    log,
    onImageRejected: detail => {
      lastImageError = detail;
    },
    onEventType: type => {
      eventTypes.add(type);
    },
    onToolCall: data => bridge.noteToolCall(data),
  });
  const approvals = new Approvals(store.get().safety.confirmTtlMs);
  /**
   * Summarize one impression prompt with the configured model route.
   *
   * Goes straight through `ctx.llm` instead of creating a hidden session: that
   * path already carries working credentials, while a fresh session defaults to
   * a provider route this deployment has no API key for.
   *
   * @param {string} prompt Fully rendered prompt.
   * @returns {Promise<string>} Model output.
   */
  const summarizeWithModel = async prompt => {
    const llm = ctx.get('llm');
    if (llm === undefined) throw new Error('llm service is unavailable');
    const config = store.get();
    // Never trust the catalog default blindly: it can name a provider this
    // deployment has no credentials for.
    const route = pickRoute(await ctx.sessionController.modelCatalog(), config.models.summarizer);
    const provider = route.provider;
    const model = route.model;
    if (provider === '' || model === '') throw new Error('no model route is configured');
    let output = '';
    const chunks = llm.stream({
      provider,
      model,
      system: '你是记忆整理器。根据用户给的旧印象和一段聊天记录，输出合并后的印象条目。只输出条目，每行以 "- " 开头，不要编号、标题或解释。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt.slice(0, 12_000) }] }],
      maxTokens: 1200,
      temperature: 0.2,
    });
    for await (const chunk of chunks) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text;
      if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
        throw new Error(chunk.reason.failure?.message ?? 'impression summary failed');
      }
    }
    return output.trim();
  };

  /**
   * Describe one sticker image with the configured model.
   *
   * @param {{ data: Uint8Array, mediaType: string }} image Downloaded preview.
   * @param {{ desc?: string, category?: string }} [sticker] Existing values, for re-analysis.
   * @returns {Promise<{ desc: string, category: string }>} Structured index fields.
   */
  const describeStickerWithModel = async (image, sticker = {}) => {
    // Images only reach the model through a real session prompt: the direct
    // llm.stream path accepts the block but yields no text for this provider.
    const bytes = image?.data ?? image;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return { desc: '', category: '' };
    const declared = image?.mediaType ?? 'image/png';
    const mediaType = detectMediaType(bytes, declared);
    const result = await driver.ask({
      scene: 'sticker-describe',
      model: pickRoute(await ctx.sessionController.modelCatalog(), store.get().models.owner),
      text: `${DESCRIBE_SYSTEM}\n\n${describePrompt(sticker)}`,
      content: [
        { type: 'text', text: `${DESCRIBE_SYSTEM}\n\n${describePrompt(sticker)}` },
        { type: 'image', data: Buffer.from(bytes).toString('base64'), mediaType },
      ],
      cwd: store.get().conversation.cwd,
      timeoutMs: 90_000,
      tier: 'owner',
    });
    const output = String(result?.text ?? '');
    if (output.trim() === '') return { desc: '', category: '', error: 'model returned no text' };
    return parseAnalysis(output);
  };

  void map.load().catch(error => log(`session map load failed: ${error.message}`));

  // QQ sessions are created in conversation.cwd. Registering that folder as a
  // workspace keeps them grouped in the sidebar instead of looking like
  // stray sessions that multiply on every rebuild.
  const ensureBridgeWorkspace = async () => {
    const cwd = store.get().conversation.cwd;
    if (typeof cwd !== 'string' || cwd.trim() === '') return;
    const registry = ctx.get('workspaceRegistry');
    if (registry === undefined || typeof registry.create !== 'function') return;
    const existing = await registry.resolveByPath?.(cwd).catch(() => undefined);
    if (existing !== undefined) return;
    const title = cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'QQ';
    await registry.create(cwd, title);
    log(`workspace ${cwd} registered for QQ sessions`);
  };
  void ensureBridgeWorkspace().catch(error => log(`workspace registration failed: ${error?.message ?? error}`));

  const bridge = new Bridge({
    stickers,
    stickerDir,
    describeSticker: describeStickerWithModel,
    store,
    driver,
    memory,
    approvals,
    map,
    attachments: ctx.get('attachments'),
    mediaDir: join(stateDir, 'media'),
    stateDir,
    controller: ctx.sessionController,
    userQuestions: ctx.get('userQuestions'),
    speech: ctx.get('speechToText'),
    // Declared above this construction on purpose: a forward reference here is
    // a TDZ error at apply() time, which kills the whole plugin.
    summarize: summarizeWithModel,
    log,
  });

  /** Every timer this plugin owns, torn down together. */
  const timers = new Set();

  /**
   * Register a repeating or one-shot timer that is cleaned up on dispose.
   *
   * @param {() => void} run Callback.
   * @param {number} ms Delay or period.
   * @param {{ once?: boolean }} [options] `once` uses setTimeout.
   * @returns {void}
   */
  const schedule = (run, ms, options = {}) => {
    const timer = options.once === true ? setTimeout(run, ms) : setInterval(run, ms);
    timer.unref?.();
    timers.add(timer);
  };

  ctx.effect(() => () => {
    for (const timer of timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    timers.clear();
  }, 'dsh-to-qq: timers');

  // Daily digest: fire once per Beijing day at the configured minute.
  let lastDigestDay = '';
  schedule(() => {
    const config = store.get();
    if (config.digest?.enabled !== true) return;
    const beijing = new Date(Date.now() + 8 * 3600 * 1000);
    if (beijing.getUTCHours() !== config.digest.hour || beijing.getUTCMinutes() !== config.digest.minute) return;
    const day = beijing.toISOString().slice(0, 10);
    if (lastDigestDay === day) return;
    lastDigestDay = day;
    const groups = config.digest.groups.length > 0 ? config.digest.groups : config.access.groups;
    for (const group of groups) {
      void bridge.sendDigestTo(`group:${group}`).catch(error => {
        log(`digest failed for ${group}: ${error?.message ?? error}`);
      });
    }
  }, 30_000);

  // Every five minutes, rebuild impressions for anyone with 100+ new messages.
  schedule(() => {
    if (store.get().memory.impressionsEnabled !== true) return;
    void bridge.summarizeImpressions().catch(error => {
      log(`impression run failed: ${error?.message ?? error}`);
    });
  }, 5 * 60_000);

  // Retention has to run on its own: the panel button is a manual escape hatch,
  // and an archive nobody prunes grows until the disk complains.
  schedule(() => {
    const days = store.get().archive.retentionDays;
    if (!(days > 0)) return;
    // Rows and their media can age out at different speeds: a file nobody points
    // at any more is dead weight, while recent rows may still be worth keeping.
    const mediaDays = Number(store.get().archive.mediaRetentionDays) || days;
    const removed = bridge.archive?.prune(days) ?? 0;
    void pruneMedia(join(stateDir, 'media'), mediaDays, { log }).then(files => {
      if (removed > 0 || files > 0) log(`retention: removed ${removed} rows (${days}d), ${files} media files (${mediaDays}d)`);
    }).catch(error => log(`retention failed: ${error?.message ?? error}`));
  }, 6 * 3600_000);

  // Ninety seconds after boot, silently fill in impressions for people who have
  // none yet. Nothing is posted to QQ; the cards just stop being empty.
  schedule(() => {
    void bridge.backfillImpressions().catch(error => {
      log(`impression backfill failed: ${error?.message ?? error}`);
    });
  }, 90_000, { once: true });

  // Stickers sync a minute after boot and twice a day after that: the list is
  // small, and only new stickers need a description.
  const syncStickers = () => {
    if (store.get().stickers?.enabled === false) return;
    void bridge.syncStickers({ describe: describeStickerWithModel, batch: store.get().stickers?.describeBatch })
      .catch(error => log(`sticker sync failed: ${error?.message ?? error}`));
  };
  schedule(syncStickers, 60_000, { once: true });
  schedule(syncStickers, 12 * 3600_000);

  // Sessions that already carry a huge history keep paying for it every turn.
  // Rebuild them shortly after boot, then periodically: a long-lived session
  // grows past the budget between restarts, and the pass is cheap when idle.
  const rebuildPass = () => {
    const limitKb = Number(store.get().conversation.autoRebuildKb) || 0;
    void bridge.autoRebuildSessions(limitKb).catch(error => log(`auto rebuild failed: ${error?.message ?? error}`));
  };
  schedule(rebuildPass, 8_000, { once: true });
  schedule(rebuildPass, 30 * 60_000);

  // Quota counters live in memory for speed; persist them so a restart does not
  // hand everyone a fresh daily allowance.
  const quotaFile = join(stateDir, 'quota.json');
  schedule(() => {
    if (bridge.quota.dirty !== true) return;
    bridge.quota.dirty = false;
    const temporary = `${quotaFile}.tmp`;
    void writeFile(temporary, JSON.stringify(bridge.quota.toJSON()), 'utf8')
      .then(() => rename(temporary, quotaFile))
      .catch(error => log(`quota save failed: ${error?.message ?? error}`));
  }, 30_000);
  // Dangerous tools called from a QQ session need an explicit `/yes` first.
  ctx.effect(() => ctx.tools.guard(execution => {
    if (store.get().safety.confirmWrite !== true) return undefined;
    const info = bridge.sessionContext(String(execution?.agent?.id ?? ''));
    if (info === undefined || info.tier !== 'owner') return undefined;
    if (!DANGEROUS_TOOLS.has(execution.name)) return undefined;
    // Approve the exact call, not the whole tool: a grant for `pwsh` would be a
    // shell window, a grant for this one command is just that command.
    if (approvals.allowed(info.scene, execution.name, execution.arguments)) return undefined;
    approvals.request(info.scene, execution.name, execution.arguments);
    const preview = approvals.pendingOf(info.scene)?.preview ?? '';
    const detail = preview === '' ? '' : `（${preview}）`;
    return `这一步需要管理员确认：${execution.name}${detail}。请在 QQ 里回复 /yes（3 分钟内只批这一条；/yes! 放开该工具 5 分钟；/全放行 一次放开全部危险工具 5 分钟），然后再让我重试。`;
  }));

  /** Panel opens requested from the pet's right-click menu. */
  let menuClicks = 0;
  /** True once the pet accepted our menu entry, so the browser hides its own bubble. */
  let petReady = false;

  // Optional: talk to dsh-pet when it is installed and running.
  ctx.effect(() => {
    const config = store.get();
    if (config.ui.pet !== true) return () => {};
    let origin = '';
    try {
      origin = ctx.webServer.getOrigin();
    } catch {
      return () => {};
    }
    const pet = new PetClient({ origin, petId: config.ui.petId || 'main', owner: 'dsh-to-qq', log });
    bridge.pet = pet;
    const abort = new AbortController();

    void (async () => {
      if (!(await pet.available())) {
        log('dsh-pet is not running; menu and bubbles are disabled');
        return;
      }
      const registered = await pet.registerMenu(['QQ 面板']);
      log(`dsh-pet menu ${registered ? 'registered' : 'rejected'}`);
      if (!registered) return;
      petReady = true;
      await pet.pollMenu(label => {
        if (label === 'QQ 面板') {
          menuClicks += 1;
          log('panel requested from dsh-pet menu');
        }
      }, abort.signal);
    })();

    return () => {
      abort.abort();
      petReady = false;
      bridge.pet = undefined;
      void pet.releaseLock();
    };
  });

  // The archive is optional: without `node:sqlite` the bridge still answers.
  ctx.effect(() => {
    /** @type {any} */
    let archive;
    let disposed = false;
    void openArchive(join(stateDir, 'archive.db'))
      .then(opened => {
        archive = opened;
        if (opened === null) {
          log('archive disabled: node:sqlite is unavailable');
          return;
        }
        if (disposed) {
          opened.close();
          return;
        }
        bridge.archive = opened;
        log(`archive ready (${opened.stats().messages} messages)`);
      })
      .catch(error => log(`archive failed: ${error.message}`));
    return () => {
      disposed = true;
      archive?.close();
      bridge.archive = null;
    };
  });

  /** Give the memory tools the current caps and the card owner for a session. */
  ctx.effect(() => {
    const applyMemoryPrivacy = () => {
    const memoryConfig = store.get().memory ?? {};
    memory.setPrivacy({
      enabled: memoryConfig.redactSensitive !== false,
      words: Array.isArray(memoryConfig.sensitiveWords) ? memoryConfig.sensitiveWords : [],
    });
  };
  applyMemoryPrivacy();
  void memory.load().catch(error => log(`memory load failed: ${error.message}`));
  void stickers.load().catch(error => log(`sticker load failed: ${error.message}`));
  void bridge.loadRebuildState().catch(error => log(`rebuild marks load failed: ${error.message}`));
  void readFile(join(stateDir, 'quota.json'), 'utf8').then(text => {
    if (bridge.quota.restore(JSON.parse(text))) log('quota counters restored');
  }).catch(() => {});
    return registerMemoryTools(ctx, {
      store: memory,
      limits: () => store.get().memory,
      resolveSender: sessionId => bridge.senders.get(String(sessionId)),
      log,
    });
  });

  // Reload which sessions are guest sessions, so a resumed agent is confined again.
  ctx.effect(() => {
    void guestStore
      .load()
      .then(() => {
        for (const [sessionId, tier] of Object.entries(guestStore.all())) guests.expect(sessionId, tier);
      })
      .catch(error => log(`guest registry load failed: ${error.message}`));
  });

  // Confine guest agents before they can run. Throwing here fails creation,
  // which is the correct outcome when a restriction cannot be installed.
  ctx.effect(() => ctx.on('agent/created', payload => {
    const tier = guests.tierOf(payload.agent.id);
    if (tier === undefined) return;
    try {
      installTierRestriction({ tools: ctx.tools, agent: payload.agent }, tier);
      log(`confined ${payload.agent.id} to ${tier}`);
    } catch (error) {
      log(`refusing unrestricted guest session ${payload.agent.id}: ${error.message}`);
      throw error;
    }
  }));

  // Send text, images, or files back into the QQ conversation that asked.
  ctx.effect(() => registerQqSendTool(ctx, { bridge, log }));

  // Let the model answer "把记忆卡发我" without a slash command.
  ctx.effect(() => registerMemoryCardTool(ctx, { bridge, store, log }));

  // Same for "今天群里聊了啥".
  ctx.effect(() => registerDigestTool(ctx, { bridge, log }));

  // Panel data for the browser half: same origin, so the page's own session applies.
  /** @type {string} */
  let routeStatus = 'pending';
  /** Reasoning translations, keyed by the original text. */
  const translated = new Map();

  /**
   * Read a small JSON request body.
   *
   * @param {import('node:http').IncomingMessage} req The request.
   * @returns {Promise<string>} UTF-8 body, truncated past 8 KiB.
   */
  const readBody = req => new Promise(resolve => {
    let body = '';
    req.on('data', (chunk) => {
      if (body.length < 8192) body += chunk.toString('utf8');
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(body));
  });

  /**
   * Translate with the configured chat model: stable, and already paid for by the
   * account the user is running.
   *
   * @param {string} text Source text.
   * @returns {Promise<string | undefined>} The translation, or undefined without a route.
   */
  const translateWithModel = async text => {
    const llm = ctx.get('llm');
    if (llm === undefined) return undefined;
    const config = store.get();
    const route = pickRoute(await ctx.sessionController.modelCatalog(), config.models.summarizer);
    const provider = route.provider;
    const model = route.model;
    if (provider === '' || model === '') return undefined;
    let output = '';
    const chunks = llm.stream({
      provider,
      model,
      system: '你是翻译助手。把用户给的文本翻译成简体中文，只输出译文，保留换行与列表结构；不要解释，不要加引号。',
      messages: [{ role: 'user', content: [{ type: 'text', text: text.slice(0, 4000) }] }],
      maxTokens: 2000,
      temperature: 0,
    });
    for await (const chunk of chunks) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text;
      if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
        throw new Error(chunk.reason.failure?.message ?? 'model translation failed');
      }
    }
    return output.trim();
  };


  const panelHandler = async (req, res) => {
  // Local-only surface: reject off-machine peers and cross-origin pages before
  // any handler runs, so configuration cannot be read or rewritten from a tab.
  const access = panelAccess({
    remoteAddress: req.socket?.remoteAddress,
    origin: req.headers.origin,
    host: req.headers.host,
  });
  if (!access.allowed) {
    log(`panel access denied: ${access.reason}`);
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
    const url = new URL(req.url ?? '/', 'http://localhost');
    /** @param {number} status @param {unknown} body */
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === '/dsh-to-qq/api/translate' && req.method === 'POST') {
        let text = '';
        try {
          text = String(JSON.parse(await readBody(req) || '{}').text ?? '');
        } catch {
          text = '';
        }
        if (text === '') {
          send(400, { error: 'empty text' });
          return;
        }
        const cached = translated.get(text);
        if (cached !== undefined) {
          send(200, { text: cached, translated: true, provider: 'cache' });
          return;
        }

        // 1) Translate with the configured model: deterministic, always available
        //    while the user's account works. Anonymous web translators are flaky.
        try {
          const viaModel = await translateWithModel(text);
          if (viaModel !== undefined && viaModel !== '') {
            if (translated.size > 200) translated.clear();
            translated.set(text, viaModel);
            send(200, { text: viaModel, translated: true, provider: 'model' });
            return;
          }
        } catch (error) {
          log(`model translation failed: ${error?.message ?? error}`);
        }

        // 2) Fall back to the built-in translator service.
        const service = ctx.get('translator');
        if (service === undefined) {
          send(200, { text, translated: false, error: 'no translator service and no model route' });
          return;
        }
        const providers = await service.availableProviders();
        if (providers.length === 0) {
          send(200, { text, translated: false, error: 'no translation provider is configured' });
          return;
        }
        // Try every eligible route in order; anonymous ones need no session, and
        // a paid one must be handed a live session id.
        const failures = [];
        const liveSession = [...bridge.senders.keys()][0];
        for (const provider of providers) {
          try {
            /** @type {Record<string, unknown>} */
            const request = { text, targetLanguage: 'zh', provider };
            if (provider === 'deepseek-account' || provider === 'deepseek-official') request.sessionId = liveSession;
            const spec = service.resolve(request);
            const result = await service.translate(spec);
            if (translated.size > 200) translated.clear();
            translated.set(text, result);
            send(200, { text: result, provider, translated: true });
            return;
          } catch (error) {
            failures.push(`${provider}: ${error?.message ?? error}`);
          }
        }
        // Nothing worked: hand back the original so the panel degrades quietly.
        send(200, { text, translated: false, error: failures.join(' | ') });
        return;
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/models') {
        try {
          send(200, { catalog: await ctx.sessionController.modelCatalog() });
        } catch (error) {
          send(500, { error: String(error?.message ?? error) });
        }
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/archive') {
        send(200, {
          stats: bridge.archive?.stats() ?? null,
          retentionDays: store.get().archive.retentionDays,
        });
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/prune' && req.method === 'POST') {
        let days = store.get().archive.retentionDays;
        try {
          const body = JSON.parse(await readBody(req) || '{}');
          if (Number.isFinite(body.days)) days = Number(body.days);
        } catch {
          // Keep the configured retention.
        }
        const removed = bridge.archive?.prune(days) ?? 0;
        const mediaDays = Number(store.get().archive.mediaRetentionDays) || days;
        const files = await pruneMedia(join(stateDir, 'media'), mediaDays, { log });
        send(200, { removed, files, days, mediaDays });
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/state') {
        const snapshot = bridge.snapshot();
        const config = store.get();
        const bindings = map.all();
        const scenes = (bridge.archive?.scenes() ?? []).map(row => ({
          scene: row.scene,
          kind: row.kind,
          lastAt: row.last_bj,
          total: row.total,
          session: bindings[row.scene] ?? null,
        }));
        send(200, {
          version: VERSION,
          transport: snapshot.state,
          counters: snapshot.counters,
          admins: snapshot.admins,
          groups: config.access.groups,
          petClicks: menuClicks,
          petReady,
          scenes,
        });
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/config' && req.method === 'GET') {
        const config = store.get();
        // Tokens never leave the host; the panel only learns whether one is set.
        const { token, httpToken, ...rest } = config.connection;
        send(200, {
          config: { ...config, connection: { ...rest, tokenSet: token !== '', httpTokenSet: httpToken !== '' } },
        });
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/config' && req.method === 'POST') {
        let incoming = {};
        try {
          incoming = JSON.parse(await readBody(req) || '{}').config ?? {};
        } catch {
          send(400, { error: 'invalid JSON body' });
          return;
        }
        const merged = mergeConfig(mergeIncomingConfig(store.get(), incoming));
        await store.save(merged);
        // Never echo the secrets back, even to the surface that just wrote them.
        const { token, httpToken, ...restConnection } = merged.connection;
        send(200, {
          ok: true,
          config: { ...merged, connection: { ...restConnection, tokenSet: token !== '', httpTokenSet: httpToken !== '' } },
        });
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/stickers') {
        if (req.method === 'POST') {
          let force = false;
          let md5 = '';
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            force = body.force === true;
            md5 = typeof body.md5 === 'string' ? body.md5 : '';
          } catch {
          }
          const stats = await bridge.syncStickers({
            describe: describeStickerWithModel,
            batch: store.get().stickers?.describeBatch,
            force,
            md5,
          });
          send(200, { ok: true, ...stats, stats: bridge.stickerStats });
          return;
        }
        const all = bridge.stickers?.all() ?? [];
        send(200, {
          total: all.length,
          read: all.filter(item => item.readAt > 0).length,
          syncedAt: bridge.stickerStats.syncedAt,
          error: bridge.stickerStats.lastError,
          enabled: store.get().stickers?.enabled !== false,
          mutedScenes: [...(bridge.stickers?.muted.keys() ?? [])],
          items: all.map(item => ({
            md5: item.md5,
            code: item.code,
            desc: item.desc,
            category: item.category,
            read: item.readAt > 0,
            manual: item.manual,
            uses: item.uses,
            file: item.file,
          })),
        });
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/stickers/preview') {
        const md5 = String(url.searchParams.get('md5') ?? '').toLowerCase();
        const sticker = bridge.stickers?.find(md5);
        if (sticker === undefined || sticker.file === '') {
          send(404, { error: 'no preview' });
          return;
        }
        const path = join(stickerDir, sticker.file);
        const bytes = await readFile(path).catch(() => undefined);
        if (bytes === undefined) {
          send(404, { error: 'preview missing on disk' });
          return;
        }
        const type = detectMediaType(new Uint8Array(bytes), 'image/png');
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' });
        res.end(bytes);
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/stickers/update' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const sticker = bridge.stickers?.update(String(body.md5 ?? ''), {
          code: body.code,
          desc: body.desc,
          category: body.category,
        });
        if (sticker === undefined) {
          send(404, { error: 'unknown sticker' });
          return;
        }
        await bridge.stickers.save();
        send(200, { ok: true, item: { md5: sticker.md5, code: sticker.code, desc: sticker.desc, category: sticker.category, read: sticker.readAt > 0 } });
        return;
      }

      if (url.pathname === '/dsh-to-qq/api/accounts') {
        if (req.method === 'GET') {
          send(200, {
            ok: true,
            accounts: accounts.status(),
            browser: findBrowser(store.get().accounts?.browserPath ?? ''),
            debugPort: Number(store.get().accounts?.debugPort) || 9333,
          });
          return;
        }
        let body = {};
        try {
          body = JSON.parse(await readBody(req) || '{}');
        } catch {
          send(400, { ok: false, error: 'invalid json' });
          return;
        }
        const action = String(body.action ?? '');
        const provider = String(body.provider ?? '');
        try {
          if (action === 'browser-open') {
            if (provider !== 'bilibili' && provider !== 'xiaohongshu') {
              send(400, { ok: false, error: 'unknown provider' });
              return;
            }
            const config = store.get();
            const browser = findBrowser(config.accounts?.browserPath ?? '');
            if (browser === '') {
              send(200, { ok: false, error: '没找到 Edge/Chrome，请在设置里填写浏览器路径' });
              return;
            }
            const url = provider === 'bilibili' ? 'https://www.bilibili.com/' : 'https://www.xiaohongshu.com/';
            await launchBrowser({ browser, profileDir: browserProfile, url, port: Number(config.accounts?.debugPort) || 9333 });
            send(200, { ok: true, browser, url, hint: '在打开的窗口里登录，登录完成后回来点「读取登录状态」' });
            return;
          }
          if (action === 'browser-read') {
            const config = store.get();
            const port = Number(config.accounts?.debugPort) || 9333;
            // The person may have signed in and then closed the window. The
            // profile keeps the login, so reopening it and retrying is enough.
            let cookies;
            let lastError = '';
            for (let attempt = 0; attempt < 4; attempt += 1) {
              try {
                cookies = await readBrowserCookies(port);
                break;
              } catch (error) {
                lastError = String(error?.message ?? error).slice(0, 120);
                if (attempt === 0) {
                  const browser = findBrowser(config.accounts?.browserPath ?? '');
                  if (browser === '') break;
                  const url = provider === 'bilibili' ? 'https://www.bilibili.com/' : 'https://www.xiaohongshu.com/';
                  await launchBrowser({ browser, profileDir: browserProfile, url, port });
                }
                await new Promise(resolve => setTimeout(resolve, 1500));
              }
            }
            if (cookies === undefined) {
              send(200, { ok: false, error: `读不到浏览器 cookie（${lastError}）。点「打开登录窗口」，登录后保持窗口开着再读取` });
              return;
            }
            const header = cookieHeaderFrom(cookies, provider);
            if (header === '') {
              send(200, { ok: false, error: provider === 'bilibili' ? '浏览器里还没有 B站 登录态' : '浏览器里还没有小红书登录态' });
              return;
            }
            const check = provider === 'bilibili' ? await verifyLogin(header) : { ok: true, nickname: '', uid: 0 };
            if (provider === 'bilibili' && (check.ok !== true || hasBilibiliSession(header) !== true)) {
              send(200, { ok: false, error: 'B站 没认这份登录态（可能还没登录完成）' });
              return;
            }
            await accounts.set(provider, { cookie: header, nickname: check.nickname, uid: check.uid, method: 'browser' });
            send(200, { ok: true, accounts: accounts.status(), nickname: check.nickname });
            return;
          }
          if (action === 'save-cookie') {
            if (provider !== 'bilibili' && provider !== 'xiaohongshu') {
              send(400, { ok: false, error: 'unknown provider' });
              return;
            }
            const cookie = String(body.cookie ?? '').trim();
            if (cookie === '') {
              send(400, { ok: false, error: 'cookie 为空' });
              return;
            }
            const check = provider === 'bilibili' ? await verifyLogin(cookie) : { ok: true, nickname: '', uid: 0 };
            if (provider === 'bilibili' && check.ok !== true) {
              send(200, { ok: false, error: 'B站没认这个 cookie（可能过期或复制不全）' });
              return;
            }
            await accounts.set(provider, { cookie, nickname: check.nickname, uid: check.uid, method: 'cookie' });
            send(200, { ok: true, accounts: accounts.status(), nickname: check.nickname });
            return;
          }
          if (action === 'verify') {
            const cookie = accounts.cookieFor(provider === 'xiaohongshu' ? 'https://www.xiaohongshu.com/' : 'https://www.bilibili.com/');
            const check = provider === 'bilibili' ? await verifyLogin(cookie) : { ok: cookie !== '', nickname: '', uid: 0 };
            send(200, { ok: true, loggedIn: check.ok, nickname: check.nickname, accounts: accounts.status() });
            return;
          }
          if (action === 'logout') {
            await accounts.clear(provider);
            send(200, { ok: true, accounts: accounts.status() });
            return;
          }
          send(400, { ok: false, error: 'unknown action' });
        } catch (error) {
          send(500, { ok: false, error: String(error?.message ?? error).slice(0, 200) });
        }
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/usage') {
        const prices = {
          input: Number(store.get().models.inputPrice) || 0,
          output: Number(store.get().models.outputPrice) || 0,
          cache: Number(store.get().models.cachePrice) || 0,
          offPeakDiscount: Number(store.get().models.offPeakDiscount) || 0,
          peakWindows: String(store.get().models.peakWindows ?? ''),
          peakHolidays: String(store.get().models.peakHolidays ?? ''),
          searchPrice: Number(store.get().models.searchPrice) || 0,
          fetchPrice: Number(store.get().models.fetchPrice) || 0,
        };
        const rows = bridge.archive?.recentTurns?.(30) ?? [];
        const recent = rows.map(row => {
          const estimate = estimateCost(
            { inputTokens: row.input_tokens, outputTokens: row.output_tokens, cacheReadTokens: row.cache_tokens },
            prices,
          );
          return {
            scene: row.scene,
            tier: row.tier,
            startedAt: row.started_at,
            durationMs: row.duration_ms,
            promptChars: row.prompt_chars,
            replyChars: row.reply_chars,
            input: estimate.input,
            output: estimate.output,
            cache: estimate.cache,
            cacheRate: cacheRate(estimate),
            cost: estimate.cost,
            offPeak: estimate.offPeak,
            calls: estimate.calls,
          };
        });
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const totals = bridge.archive?.usageTotals?.(midnight.getTime()) ?? { turns: 0, input: 0, output: 0, cache: 0 };
        const dayRows = bridge.archive?.turnsSince?.(midnight.getTime()) ?? [];
        const dayEstimates = dayRows.map(row => estimateCost(
          { inputTokens: row.input_tokens, outputTokens: row.output_tokens, cacheReadTokens: row.cache_tokens },
          prices,
          row.started_at,
          { searchCalls: row.search_calls, fetchCalls: row.fetch_calls },
        ));
        send(200, {
          prices,
          today: {
            ...totals,
            cost: dayEstimates.every(item => item.cost !== null) ? dayEstimates.reduce((sum, item) => sum + (item.cost ?? 0), 0) : null,
            offPeakTurns: dayEstimates.filter(item => item.offPeak).length,
            calls: dayEstimates.reduce((sum, item) => sum + (item.calls ?? 0), 0),
            cacheRate: cacheRate(totals),
          },
          recent,
        });
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/sessions') {
        try {
          if (req.method === 'POST') {
            send(200, { ok: true, ...(await bridge.cleanupSessions({ dry: false })) });
            return;
          }
          send(200, await bridge.cleanupSessions({ dry: true }));
        } catch (error) {
          send(500, { ok: false, error: String(error?.message ?? error).slice(0, 200) });
        }
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/impressions') {
        const stats = bridge.impressionStats;
        if (req.method === 'POST') {
          if (bridge.impressionBusy === true) {
            send(200, { started: false, busy: true, stats });
            return;
          }
          // Fire and forget: the run takes minutes, the panel polls for progress.
          void bridge.backfillImpressions({ relaxed: true }).catch(error => {
            log(`manual impression backfill failed: ${error?.message ?? error}`);
          });
          send(200, { started: true, busy: true, stats });
          return;
        }
        send(200, { busy: bridge.impressionBusy === true, enabled: store.get().memory.impressionsEnabled === true, stats });
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/memory') {
        if (req.method === 'GET') {
          const cards = Object.entries(memory.toJSON()).map(([qq, card]) => ({
            qq: Number(qq),
            name: card.name ?? '',
            persona: card.persona ?? null,
            notes: card.notes ?? [],
          }));
          send(200, { cards });
          return;
        }
        let body = {};
        try {
          body = JSON.parse(await readBody(req) || '{}');
        } catch {
          send(400, { error: 'invalid JSON body' });
          return;
        }
        const qq = Number(body.qq);
        if (!Number.isInteger(qq) || qq <= 0) {
          send(400, { error: 'qq is required' });
          return;
        }
        if (body.clear === true) {
          await memory.clear(qq);
          send(200, { ok: true });
          return;
        }
        if (typeof body.persona === 'string') {
          await memory.setPersona(qq, body.persona, store.get().memory.personaLimit);
        }
        if (Array.isArray(body.notes)) {
          const card = memory.get(qq);
          card.notes = body.notes
            .filter(note => note !== null && typeof note === 'object' && typeof note.text === 'string')
            .map(note => ({ at: Number(note.at) || Date.now(), text: String(note.text) }));
          await memory.save();
        }
        send(200, { ok: true });
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/pose') {
        const pose = await bridge.pet?.pose();
        send(200, pose ?? {});
        return;
      }
      if (url.pathname === '/dsh-to-qq/api/messages') {
        const scene = url.searchParams.get('scene') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? '50');
        send(200, { scene, messages: bridge.archive?.recent(scene, limit) ?? [] });
        return;
      }
      send(404, { error: 'unknown endpoint' });
    } catch (error) {
      send(500, { error: String(error?.message ?? error) });
    }
  };

  ctx.effect(() => {
    /** @type {Array<{ kind: string, path: string }>} */
    const routes = [
      { kind: 'prefix', path: '/dsh-to-qq/api/' },
      { kind: 'prefix', path: '/dsh-to-qq/api' },
      { kind: 'exact', path: '/dsh-to-qq/api/state' },
      { kind: 'exact', path: '/dsh-to-qq/api/messages' },
      { kind: 'exact', path: '/dsh-to-qq/api/translate' },
      { kind: 'exact', path: '/dsh-to-qq/api/pose' },
      { kind: 'exact', path: '/dsh-to-qq/api/config' },
      { kind: 'exact', path: '/dsh-to-qq/api/models' },
      { kind: 'exact', path: '/dsh-to-qq/api/archive' },
      { kind: 'exact', path: '/dsh-to-qq/api/prune' },
      { kind: 'exact', path: '/dsh-to-qq/api/memory' },
      { kind: 'exact', path: '/dsh-to-qq/api/impressions' },
      { kind: 'exact', path: '/dsh-to-qq/api/sessions' },
      { kind: 'exact', path: '/dsh-to-qq/api/usage' },
      { kind: 'exact', path: '/dsh-to-qq/api/accounts' },
      { kind: 'exact', path: '/dsh-to-qq/api/stickers' },
      { kind: 'exact', path: '/dsh-to-qq/api/stickers/preview' },
      { kind: 'exact', path: '/dsh-to-qq/api/stickers/update' },
    ];
    const disposers = [];
    const failures = [];
    for (const route of routes) {
      try {
        disposers.push(ctx.webServer.register({ ...route, handler: panelHandler }));
      } catch (error) {
        failures.push(`${route.kind}:${route.path} ${error?.message ?? error}`);
      }
    }
    routeStatus = disposers.length > 0 ? `ok (${disposers.length} routes)` : `failed: ${failures.join('; ')}`;
    log(`panel routes ${routeStatus}`);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Teardown is best-effort.
        }
      }
    };
  });

  // Search the archive: "what was said", "find that image", "what did X say".
  ctx.effect(() => ctx.tools.register({
    name: 'qq_history',
    description: 'Search archived QQ messages: who said what, when (Beijing time). Rows with media carry the saved absolute path; open it with read_image (or read) when the content matters. Use it for questions about earlier conversations, locating a past image or file, or checking what a specific person said.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string', description: 'Substring to match inside the message text.' },
        sender_id: { type: 'number', description: 'Exact sender QQ number.' },
        scene: { type: 'string', description: 'Scene key such as "group:20001" or "dm:10001".' },
        days: { type: 'number', description: 'How far back to look, in days; default 7.' },
        limit: { type: 'number', description: 'Maximum rows to return; default 5000, max 20000. Prefer narrow filters over a big limit: results go into the model context.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args = {}) {
      if (bridge.archive === null || bridge.archive === undefined) {
        return { report: '档案不可用：宿主缺少 node:sqlite。', rows: 0 };
      }
      const days = Number.isFinite(args.days) ? Number(args.days) : 7;
      const rows = bridge.archive.search({
        keyword: typeof args.keyword === 'string' ? args.keyword : undefined,
        senderId: Number.isInteger(args.sender_id) ? args.sender_id : undefined,
        scene: typeof args.scene === 'string' ? args.scene : undefined,
        since: Math.floor(Date.now() / 1000) - Math.max(1, days) * 86400,
        limit: Number.isInteger(args.limit) ? Math.min(20_000, Math.max(1, args.limit)) : 5000,
      });
      if (rows.length === 0) return { report: '没有匹配的记录。', rows: 0 };
      const report = rows
        .map(row => `${row.time_bj} [${row.scene}] ${row.sender_name}(${row.sender_id})${row.media_kind === null ? '' : ` [${row.media_kind}]`}${row.media_path === null || row.media_path === undefined ? '' : ` (文件: ${row.media_path})`}: ${row.text}`)
        .join('\n');
      return { report, rows: rows.length };
    },
    presentCall: () => ({ card: 'generic', title: 'Search QQ archive', kind: 'search', rawInput: {} }),
  }));

  ctx.effect(() => {
    void store
      .load()
      .then(async () => {
        await ensureSnowLuma({ config: store.get(), log });
        bridge.start();
        log(`bridge ${bridge.state}`);
      })
      .catch(error => log(`config load failed: ${error.message}`));
    store.watch();
    const unsubscribe = store.onChange(() => {
      log('configuration changed; restarting transport');
      applyMemoryPrivacy();
      bridge.start();
    });
    return () => {
      unsubscribe();
      store.dispose();
      bridge.stop();
    };
  });

  ctx.effect(() => ctx.tools.register({
    name: 'qq_status',
    description: 'Report the dsh-to-qq bridge state: transport status, counters, bound sessions, configured administrators, and blocking configuration gaps. Read-only.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute() {
      if (!store.loaded) await store.load();
      const config = store.get();
      const snapshot = bridge.snapshot();
      await map.load();
      const pending = [];
      if (config.connection.token === '') pending.push('OneBot WS token is empty');
      if (config.access.admins.length === 0) pending.push('no admin QQ configured');
      if (config.access.groupMode === 'whitelist' && config.access.groups.length === 0) pending.push('group whitelist is empty (no group will answer)');
      const report = [
        `dsh-to-qq ${VERSION}`,
        `panel route ${routeStatus}`,
        `transport ${snapshot.state}`,
        `onebot ${config.connection.wsUrl}${config.connection.eventPath}`,
        `admins ${snapshot.admins.join(',') || '(none)'}`,
        `groups ${config.access.groupMode} [${config.access.groups.join(',') || 'none'}]`,
        `sessions ${Object.keys(map.all()).length} buffered scenes ${snapshot.scenes}`,
        `events ${snapshot.counters.events} messages ${snapshot.counters.messages} deduped ${snapshot.counters.deduped}`,
        `ignored ${snapshot.counters.ignored} throttled ${snapshot.counters.throttled} answered ${snapshot.counters.answered} failed ${snapshot.counters.failed} errors ${snapshot.counters.errors}`,
        `quota day ${bridge.quota.snapshot().day} senders ${bridge.quota.snapshot().senders} scenes ${bridge.quota.snapshot().scenes}${bridge.quota.dirty ? " (unsaved)" : ""}`,
        `bot ${bridge.selfId === 0 ? "(unknown)" : bridge.selfId}${bridge.selfId === 0 ? "" : " (pinned)"}`,
        `context last ${bridge.contextStats?.chars ?? 0} chars (saved ${bridge.contextStats?.skipped ?? 0})`,
        `config ${store.file}`,
        lastImageError === '' ? 'images ok' : `last image error: ${lastImageError}`,
        (() => {
          const speech = ctx.get('speechToText');
          const fallback = config.voice?.command ?? '';
          const voiceHint = fallback === '' ? 'QQ 原生转写 only' : 'QQ native + command fallback';
          if (speech === undefined) return `speech: unavailable (${voiceHint})`;
          const snapshot = speech.snapshot();
          const providers = snapshot?.providers ?? [];
          if (providers.length === 0) return `speech: no provider (${voiceHint})`;
          const list = providers.map(provider => {
            const phase = provider.preparation?.phase ?? 'unknown';
            const step = provider.preparation?.step ?? '';
            return `${provider.name ?? provider.id}(${phase}${step === '' ? '' : `/${step}`})`;
          });

          const selected = snapshot?.selection?.providerId ?? 'none';
          return `speech: selected ${selected} · ${list.join(', ')}`;
        })(),
        `questions parked: ${bridge.questions.size === 0 ? 'none' : [...bridge.questions.keys()].join(', ')}`,
        `events seen: ${eventTypes.size === 0 ? '(none yet)' : [...eventTypes].join(', ')}`,
        bridge.lastToolCall === '' ? 'tool calls: none yet' : `last tool call: ${bridge.lastToolCall}`,
        `models: preset ${config.models.permissionPreset || "（跟随 DSH）"} / owner effort ${config.models.owner.effort || "（默认）"}`,
        (() => {
          const last = bridge.archive?.recentTurns?.(1)?.[0];
          if (last === undefined) return 'usage: 还没有记录';
          return `usage: 上一轮 输入 ${last.input_tokens} / 输出 ${last.output_tokens} / 缓存 ${last.cache_tokens}`;
        })(),
        (() => `friends: ${bridge.friendsSyncedAt === 0 ? '未同步' : `${bridge.friends.size} 个`}`)(),
        (() => {
          const stats = bridge.compactionStats ?? { count: 0, lastAt: 0 };
          return stats.count === 0
            ? 'compact: 还没有压缩过'
            : `compact: ${stats.count} 次 / 最近 ${new Date(stats.lastAt).toLocaleString('zh-CN', { hour12: false })}`;
        })(),
        `impressions: filled ${bridge.impressionStats.backfillFilled} / scanned ${bridge.impressionStats.scanned} / failed ${bridge.impressionStats.failed} / retried ${bridge.impressionStats.retried ?? 0} / last ${bridge.impressionStats.lastAt === 0 ? 'never' : new Date(bridge.impressionStats.lastAt).toLocaleString('zh-CN', { hour12: false })}${bridge.impressionStats.lastError === '' ? '' : ` (error: ${bridge.impressionStats.lastError})`}`,
        `stickers: ${bridge.stickers?.size ?? 0} known / ${bridge.stickers?.all().filter(item => item.desc !== '').length ?? 0} described / synced ${bridge.stickerStats.syncedAt === 0 ? 'never' : new Date(bridge.stickerStats.syncedAt).toLocaleString('zh-CN', { hour12: false })}`,
        pending.length === 0 ? 'ready' : `pending: ${pending.join('; ')}`,
      ].join('\n');
      return { report, snapshot };
    },
    presentCall: () => ({ card: 'generic', title: 'DSH to QQ status', kind: 'read', rawInput: {} }),
  }));

  // Stickers: the model picks from the account's own 收藏表情.
  ctx.effect(() => registerStickerTool(ctx, { bridge, log }));
  ctx.effect(() => registerEmojiTool(ctx, { bridge, log }));
  ctx.effect(() => registerPageTool(ctx, { log, cookieFor: url => accounts.cookieFor(url) }));
  ctx.effect(() => registerBilibiliTool(ctx, {
    accounts,
    profileDir: browserProfile,
    debugPort: () => Number(store.get().accounts?.debugPort) || 9333,
    browserPath: () => store.get().accounts?.browserPath ?? '',
    log,
  }));
}












































































































































































