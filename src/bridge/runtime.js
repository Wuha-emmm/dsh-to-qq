
/**
 * Bridge runtime.
 *
 * Transport and policy are shared by every tier. Group turns are answered from a
 * bounded context window with the sender's identity attached; private owner
 * turns go straight to the bound session, whose own history is the context.
 */

import { OneBotClient } from '../transport/onebot.js';
import { normalizeEvent, chunkText, flattenSegments } from './events.js';
import { admit, blockedWord, tierOf } from '../policy/tiers.js';
import { Quota, Semaphore } from '../policy/quota.js';
import { SceneBuffer, renderContext } from '../context/buffer.js';
import { InjectionTracker, entrySignature } from '../context/injection.js';
import { formatRecap } from '../context/recap.js';
import { renderCard } from '../memory/store.js';
import { renderTextImageBase64 } from '../render/text-image.js';
import { promptImageParts, persistImage, imageSegments, looksLikeSticker, downloadImage } from '../media/inbound.js';
import { describeQuestions, parseReply, extractPending } from './questions.js';
import { parseCommand, formatSessionList, extractSessions, cleanupCandidates } from './commands.js';
import { voiceSegments, transcribeVoice } from '../media/voice.js';
import { fetchForwards } from '../media/forward.js';
import { renderStickerBlock } from '../stickers/catalog.js';
import { detectMediaType } from '../media/inbound.js';
import { renderFaceList } from '../stickers/faces.js';
import { saveThumbnail, readThumbnail } from '../media/thumbnail.js';
import { wantsNoStickers, wantsStickers } from '../stickers/mute.js';
import { fileSegments, fetchInboundFile } from '../media/inbound-file.js';
import { renderMemoryCard, renderDigestCard } from '../render/memory-card.js';
import { summarizeDigest, formatDigest, startOfBeijingDay, DIGEST_ROW_LIMIT } from '../digest/daily.js';
import { dueForAutoNote, autoNotePrompt } from '../memory/autonote.js';
import { summarizeImpressions, backfillImpressions } from './impression-run.js';
import { shouldStaySilent } from './reply.js';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** How many recent message keys are remembered for de-duplication. */
const SEEN_LIMIT = 800;

/** Chunk size for one QQ text message. */
const CHUNK_LIMIT = 1500;

/** Hard cap on buffered lines per scene, above every configured window. */
/**
 * Token literal, or the value of the configured environment variable.
 *
 * Keeping the secret in an environment variable means `config.json` holds a name
 * instead of a value, so a copied config or a screenshot leaks nothing.
 *
 * @param {string} literal Inline token from the config.
 * @param {string} envName Environment variable that holds the token.
 * @returns {string} Resolved token, possibly empty.
 */
function resolveToken(literal, envName) {
  const direct = String(literal ?? '').trim();
  if (direct !== '') return direct;
  const name = String(envName ?? '').trim();
  if (name === '') return '';
  return String(process.env[name] ?? '').trim();
}

const BUFFER_LIMIT = 200;

/** What a throttled sender is told, per quota reason. */
const QUOTA_REPLY = {
  'member-daily': '你今天的额度用完了，明天再来吧。',
  'group-daily': '这个群今天的额度用完了。',
  rate: '发得太快了，先缓一缓。',
};

/**
 * Wait for a number of milliseconds.
 *
 * @param {number} ms Delay.
 * @returns {Promise<void>} Resolves after the delay.
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Classify a message's media, if any.
 *
 * @param {ReadonlyArray<{ type: string }>} segments Message segments.
 * @returns {string | undefined} `image`, `video`, `voice`, `file`, or undefined.
 */
function mediaKindOf(segments) {
  if (!Array.isArray(segments)) return undefined;
  for (const segment of segments) {
    if (segment?.type === 'image' || segment?.type === 'mface') return 'image';
    if (segment?.type === 'video') return 'video';
    if (segment?.type === 'record') return 'voice';
    if (segment?.type === 'file') return 'file';
  }
  return undefined;
}

/** Reconnecting bridge between OneBot and DSH sessions. */
export class Bridge {
  /**
   * Pull the account's sticker list and learn missing descriptions.
   *
   * @param {{ describe?: (image: { data: Uint8Array, mediaType: string }) => Promise<string>, batch?: number }} [options] Wiring.
   * @returns {Promise<{ total: number, added: number, described: number }>} Result counters.
   */
  async syncStickers(options = {}) {
    if (this.stickers === undefined || this.client === undefined) return { total: 0, added: 0, described: 0, previewed: 0 };
    let added = 0;
    try {
      const merged = await this.stickers.sync(this.client);
      added = merged.added;
      this.stickerStats.total = merged.total;
      this.stickerStats.syncedAt = Date.now();
      this.stickerStats.lastError = '';
      this.log(`stickers: ${merged.total} known (${merged.added} new)`);
    } catch (error) {
      this.stickerStats.lastError = String(error?.message ?? error).slice(0, 160);
      this.log(`sticker sync failed: ${this.stickerStats.lastError}`);
      return { total: this.stickers.size, added, described: 0, previewed: 0 };
    }

    // One download per sticker serves both jobs: a shrunken preview on disk and
    // (when it is still unread) the description. QQ serves full-size originals,
    // so previews are capped per run instead of pulling the whole library.
    const describe = options.describe;
    const describeBatch = Math.max(0, Math.min(100, Number(options.batch) || 20));
    const previewBatch = Math.max(0, Math.min(100, Number(options.previewBatch) || 40));
    // One sticker at a time is allowed: the settings page can re-analyse just the
    const only = typeof options.md5 === 'string' ? options.md5.toLowerCase() : '';
    const workers = this.stickers.all().filter(sticker => sticker.url !== '' && (only === '' || sticker.md5 === only));
    // Descriptions are independent: a fresh session per batch is enough, and
    // stops a 130-turn session from re-sending every earlier reply each turn.
    const stickerScene = 'sticker-describe';
    const resetStickerSession = async () => { const previous = this.map?.get?.(stickerScene); await this.map?.remove?.(stickerScene); await this.#archiveReplaced(previous); };
    await resetStickerSession();
    let previewed = 0;
    let described = 0;
    let repairs = 0;

    for (const sticker of workers) {
      const explicit = only !== '';
      const wantsText = sticker.readAt === 0 || (options.force === true && (explicit || sticker.manual !== true));
      const needsText = wantsText && typeof describe === 'function' && described < describeBatch;
      const previewSize = sticker.file === '' || this.stickerDir === ''
        ? 0
        : await stat(join(this.stickerDir, sticker.file)).then(info => info.size).catch(() => 0);
      const needsPreview = sticker.file === '' && previewed < previewBatch;
      // Older previews stored the original bytes (often several MB). Rebuild a
      // bounded number per run so the attachment limit is never hit.
      const needsRepair = previewSize > 4 * 1024 * 1024 && repairs < 40;
      if (!needsPreview && !needsText && !needsRepair) continue;

      try {
        let small;
        if (needsRepair) repairs += 1;
        else if (previewSize > 0) small = await readThumbnail(join(this.stickerDir, sticker.file));

        if (small === undefined) {
          const image = await downloadImage({ data: { url: sticker.url } });
          if (this.stickerDir !== '') {
            const name = `${sticker.md5}.png`;
            await mkdir(this.stickerDir, { recursive: true });
            const saved = await saveThumbnail(image.data, join(this.stickerDir, name), {
              size: 160,
              log: this.log,
            });
            if (saved) {
              this.stickers.setFile(sticker.md5, name);
              previewed += 1;
              small = await readThumbnail(join(this.stickerDir, name));
            }
          }
          if (small === undefined) small = image.data;
        }

        // A failed shrink falls back to the original bytes; never hand those to
        // the attachment service when they exceed its limit.
        if (needsText && small !== undefined && small.length > 6 * 1024 * 1024) {
          this.stickerStats.lastError = `preview is ${Math.round(small.length / 1048576)} MB, shrinking failed`;
          this.log(`sticker preview too large for ${sticker.md5.slice(0, 6)}`);
          continue;
        }

        if (needsText) {
          const analysis = await describe(small);
          if (this.stickers.setDescription(sticker.md5, analysis, undefined, { force: options.force === true })) {
            described += 1;
            this.stickerStats.described += 1;
            this.stickerStats.lastError = '';
          } else if (String(analysis?.desc ?? '').trim() === '') {
            this.stickerStats.lastError = 'model returned an empty description';
            this.log(`sticker describe returned nothing for ${sticker.md5.slice(0, 6)}`);
          }
        }
      } catch (error) {
        this.stickerStats.lastError = String(error?.message ?? error).slice(0, 160);
        this.log(`sticker media failed for ${sticker.md5.slice(0, 6)}: ${this.stickerStats.lastError}`);
      }
    }

    await resetStickerSession();

    this.stickerStats.total = this.stickers.size;
    await this.stickers.save().catch(error => this.log(`sticker save failed: ${error?.message ?? error}`));
    return { total: this.stickers.size, added, described, previewed };
  }

  /**
   * How many stickers this scene may still receive this hour.
   *
   * @param {string} scene Scene key.
   * @returns {{ allowed: boolean, sent: number, limit: number }} Verdict.
   */
  stickerBudget(scene) {
    const limit = Math.max(0, Number(this.store.get().stickers?.perHourPerScene) ?? 3);
    const now = Date.now();
    const recent = (this.stickerSends.get(scene) ?? []).filter(at => now - at < 3600_000);
    this.stickerSends.set(scene, recent);
    return { allowed: limit > 0 && recent.length < limit, sent: recent.length, limit };
  }

  /**
   * Record one sticker send for rate limiting.
   *
   * @param {string} scene Scene key.
   * @param {{ md5: string }} sticker Sticker sent.
   * @returns {void}
   */
  noteFaceSent(scene) {
    const recent = this.stickerSends.get(scene) ?? [];
    recent.push(Date.now());
    this.stickerSends.set(scene, recent);
  }

  /**
   * Record one sticker send for rate limiting.
   *
   * @param {string} scene Scene key.
   * @param {{ md5: string }} sticker Sticker sent.
   * @returns {void}
   */
  noteStickerSent(scene, sticker) {
    const recent = this.stickerSends.get(scene) ?? [];
    recent.push(Date.now());
    this.stickerSends.set(scene, recent);
    this.stickers?.recordUse(sticker.md5);
    this.cardsSent += 0;
    void this.stickers?.save().catch(() => {});
  }

  /**
   * Prompt block listing the sticker catalog.
   *
   * @returns {string} Text, or '' when disabled or empty.
   */
  /**
   * Local sticker preview as a `file:///` source.
   *
   * Sending the 160 px preview with sticker flags keeps the bubble small; QQ
   * renders the original URL at full size.
   *
   * @param {{ file?: string }} sticker Sticker.
   * @returns {string} A file URL, or an empty string when no preview exists.
   */
  stickerImageSource(sticker) {
    if (this.stickerDir === '' || typeof sticker?.file !== 'string' || sticker.file === '') return '';
    const path = join(this.stickerDir, sticker.file).replace(/\\/g, '/');
    return `file:///${path.replace(/^\/+/, '')}`;
  }

  stickerBlock(scene, injection) {
    if (this.stickers === undefined) return '';
    const config = this.store.get();
    if (config.stickers?.enabled === false) return '';
    const limit = Math.max(0, Number(config.stickers?.inPrompt) || 24);
    const block = renderStickerBlock(this.stickers.all(), { limit, muted: this.stickers.isMuted(scene) });
    const faces = renderFaceList();
    const parts = [block, faces].filter(part => part !== '');
    if (parts.length === 0) return '';
    return injection.fixed('stickers', `\n\n${parts.join('\n')}`);
  }

  /**
   * @param {object} options Runtime options.
   * @param {import('../config/store.js').ConfigStore} options.store Live configuration.
   * @param {{ ask: (request: any) => Promise<{ sessionId: string, text: string }> }} options.driver DSH session driver.
   * @param {import('../memory/store.js').MemoryStore} [options.memory] Memory cards.
   * @param {import('../policy/approvals.js').Approvals} [options.approvals] Two-step confirmations.
   * @param {(line: string) => void} [options.log] Diagnostic sink.
   */
  constructor(options) {
    this.store = options.store;
    this.driver = options.driver;
    /** Host speech registry (ctx.speechToText), when the deployment provides one. */
    this.speech = options.speech;
    /** @type {((prompt: string) => Promise<string>) | undefined} */
    this.summarize = options.summarize;
    /** @type {import('../policy/approvals.js').Approvals | undefined} */
    this.approvals = options.approvals;
    /** @type {import('../memory/store.js').MemoryStore | undefined} */
    this.memory = options.memory;
    /** Where inbound images are archived; empty disables the media archive. */
    this.mediaDir = typeof options.mediaDir === 'string' ? options.mediaDir : '';
    /** @type {any} */
    this.archive = options.archive ?? null;
    /** @type {any} */
    this.attachments = options.attachments ?? undefined;
    /** The session controller, used to read pending questions while a turn blocks. */
    this.controller = options.controller;
    /** `ctx.userQuestions`, when the Host exposes it. */
    this.userQuestions = options.userQuestions;
    /** Scene -> { sessionId, callId, questions } for an unanswered DSH question. */
    this.questions = new Map();
    /** Scene -> interval id while a turn polls for questions. */
    this.questionPolls = new Map();
    /** Last thing the question probe saw, surfaced by `qq_status`. */
    /** Event types seen during turns, surfaced by `qq_status` to learn shapes. */
    this.eventTypes = new Set();
    /** Sender -> answered turns, for the periodic impression nudge. */
    this.turnCounts = new Map();
    /** Last `tool/call` payload, so a pending question can be identified. */
    this.lastToolCall = '';
    /** Cards posted in the current turn, so the follow-up text can be dropped. */
    this.cardsSent = 0;
    /** True while an impression run is in flight, so two never overlap. */
    this.impressionBusy = false;
    /** Counters for qq_status: how the impression runs are going. */
    this.impressionStats = { backfillFilled: 0, scanned: 0, failed: 0, skippedExisting: 0, skippedThin: 0, lastError: '', lastAt: 0, startedAt: 0, total: 0 };
    // Restore the last run's counters so a restart does not blank the panel.
    if (typeof options.memory?.impressionStats === 'function') {
      Object.assign(this.impressionStats, options.memory.impressionStats());
    }
    // Restore the cooldown map too, so a restart does not re-summarize everyone.
    const runs = typeof options.memory?.impressionRuns === 'function' ? options.memory.impressionRuns() : {};
    this.impressionRanAt = new Map(Object.entries(runs).map(([qq, at]) => [Number(qq), Number(at)]));

    /** Sticker library (收藏表情), filled by `syncStickers`. */
    this.stickers = options.stickers;
    /** Scene -> send timestamps inside the current hour. */
    this.stickerSends = new Map();
    /** Counters for `qq_status` and the settings page. */
    this.stickerStats = { syncedAt: 0, total: 0, described: 0, lastError: '' };
    /** Where sticker previews live, so the settings grid can show them. */
    this.stickerDir = options.stickerDir ?? '';
    /** Scene -> last `/列表` result, so `/切换 2` knows what 2 means. */
    this.sessionChoices = new Map();
    /** True while `/暂停` is in effect. */
    this.paused = false;
    /** The scene -> session mapping, used by `/切换` and `/新建`. */
    this.map = options.map;
    this.log = options.log ?? (() => {});
    /** @type {OneBotClient | undefined} */
    this.client = undefined;
    /** @type {string[]} */
    this.seenOrder = [];
    /** @type {Set<string>} */
    this.seen = new Set();
    /** Scenes with a turn in flight, so one scene never interleaves two turns. */
    this.busy = new Set();
    this.buffer = new SceneBuffer(BUFFER_LIMIT);
    /** Scene -> last backfill attempt, so a thin buffer is refilled at most once a minute. */
    this.backfilled = new Map();
    /** Session -> QQ owner, so memory tools act on the right card. */
    this.senders = new Map();
    /** Session -> { qq, scene, tier }, so qq_send answers in the right place. */
    this.sessionDetails = new Map();
    /** Bot account; 0 until the first event (or connection.botUin) pins it. */
    this.selfId = 0;
    /** Recap text waiting for the next message of a rebuilt scene. */
    /** Scenes rebuilt (not /新建): the next message carries a recap from the archive. */
    /** Optional hook that hides a replaced session from the sidebar. */
    this.archiveSession = options.archiveSession;
    this.rebuildMarks = new Map();
    /** Last reply text per scene, so a bare "啥意思" can point at it. */
    this.lastReply = new Map();
    /** Scene -> epoch ms of the last automatic rebuild, so a pass cannot thrash. */
    this.autoRebuiltAt = new Map();
    /** Per-scene injection state: which fixed blocks the session already has. */
    this.injections = new Map();
    /** Directory for rebuilds.json; empty disables persistence. */
    this.stateDir = options.stateDir ?? '';
    this.titledSessions = new Set();
    /** group id -> display name, so a title costs one call. */
    this.groupNames = new Map();
    this.counters = { events: 0, messages: 0, deduped: 0, ignored: 0, throttled: 0, answered: 0, failed: 0, errors: 0 };
    this.quota = new Quota();
    this.semaphore = new Semaphore(2);
    this.state = 'idle';
  }

  /** Open the transport using the current configuration. */
  start() {
    this.stop();
    const config = this.store.get();
    if (config.connection.enabled !== true) {
      this.state = 'disabled';
      return;
    }
    if (config.connection.token === '') {
      this.state = 'no-token';
      this.log('connection.token is empty; set the OneBot token in the settings page');
      return;
    }
    this.client = new OneBotClient({
      httpUrl: config.connection.httpUrl,
      wsUrl: config.connection.wsUrl,
      eventPath: config.connection.eventPath,
      token: resolveToken(config.connection.token, config.connection.tokenEnv),
      httpToken: resolveToken(
        config.connection.httpToken === '' ? config.connection.token : config.connection.httpToken,
        config.connection.httpTokenEnv === '' ? config.connection.tokenEnv : config.connection.httpTokenEnv,
      ),
      reconnect: config.connection.reconnect,
      onEvent: event => {
        void this.handle(event);
      },
      onState: (state, detail) => {
        this.state = state;
        this.semaphore = new Semaphore(config.limits.concurrency);
        this.log(`transport ${state}${detail === undefined ? '' : ` (${detail})`}`);
      },
      onError: error => {
        this.counters.errors += 1;
        this.log(`transport error: ${error.message}`);
      },
    });
    this.client.start();
  }

  /** Close the transport. */
  stop() {
    this.client?.stop();
    this.client = undefined;
    this.state = 'stopped';
  }

  /** @returns {object} A snapshot for the status tool. */
  snapshot() {    return {
      state: this.state,
      counters: { ...this.counters },
      busy: [...this.busy],
      scenes: this.buffer.scenes.size,
      admins: this.store.get().access.admins.map(admin => admin.qq),
    };
  }

  /**
   * Look up the QQ conversation a session belongs to.
   *
   * @param {string} sessionId DSH session id.
   * @returns {{ qq: number, scene: string, tier: string } | undefined} The binding.
   */
  sessionContext(sessionId) {
    return this.sessionDetails.get(String(sessionId));
  }

  /**
   * Begin watching a running turn for a DSH question that needs an answer.
   *
   * @param {any} message The message that started the turn.
   * @param {string} sessionId Its DSH session.
   * @returns {void}
   */
  #startQuestionPoll(message, sessionId) {
    // Polling stays off until the question API is confirmed: `projections` does
    // not take a session id, and a wrong call only produces misleading errors.
    // The event types collected per turn are how we learn the real shape.
    void message;
    void sessionId;
  }

  /**
   * Post the daily digest of one scene without an inbound message.
   *
   * @param {string} scene Scene key, e.g. `group:20001`.
   * @param {string} [label] Human label for the scene.
   * @returns {Promise<boolean>} True when a message was sent.
   */
  async sendDigestTo(scene, label) {
    if (this.archive === null || this.archive === undefined || this.client === undefined) return false;
    if (!scene.startsWith('group:')) return false;
    const since = Math.floor(startOfBeijingDay() / 1000);
    const rows = this.archive.search({ scene, since, limit: DIGEST_ROW_LIMIT });
    const text = formatDigest(
      summarizeDigest(rows),
      label ?? `群 ${scene.slice(6)}`,
      new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }),
    );
    await this.client.call(
      'send_group_msg',
      { group_id: Number(scene.slice(6)), message: [{ type: 'text', data: { text } }] },
      { timeoutMs: 15_000 },
    );
    return true;
  }

  /**
   * Record something the bridge sent on its own, without an inbound message.
   *
   * @param {string} scene Scene key, e.g. `group:20001`.
   * @param {string} text What was sent.
   * @param {string} [mediaKind] `image`, `file`, or undefined.
   * @returns {void}
   */
  recordSceneOutbound(scene, text, mediaKind) {
    if (this.archive === null || this.archive === undefined) return;
    const inGroup = scene.startsWith('group:');
    const id = Number(scene.slice(scene.indexOf(':') + 1));
    this.recordOutbound({
      selfId: this.selfId ?? 0,
      kind: inGroup ? 'group' : 'dm',
      scene,
      peerId: id,
      groupId: inGroup ? id : undefined,
    }, text, mediaKind);
  }

  /**
   * Note one event type seen during a turn, for diagnosing unknowns.
   *
   * @param {string} type Event type.
   * @returns {void}
   */
  noteEventType(type) {
    this.eventTypes.add(type);
  }

  /**
   * Refresh impressions for everyone with enough new messages.
   *
   * @returns {Promise<number>} How many cards were updated.
   */
  async summarizeImpressions() {
    return summarizeImpressions(this);
  }

  /**
   * Build first impressions for people who have none yet, without speaking.
   *
   * @param {{ perSender?: number }} [options] How many messages to read per person.
   * @returns {Promise<number>} How many cards were filled in.
   */
  async backfillImpressions(options = {}) {
    return backfillImpressions(this, options);
  }

  /**
   * Record that a card was posted this turn.
   *
   * @returns {void}
   */
  noteCardSent() {
    this.cardsSent += 1;
  }

  /**
   * Note a tool call; when it is a question, remember it for the owner to answer.
   *
   * The payload carries `{ callId, name, arguments, sessionId }`. `arguments` is
   * a JSON string, so it is parsed before looking for the question batch.
   *
   * @param {any} data The `tool/call` event payload.
   * @returns {void}
   */
  noteToolCall(data) {
    let text;
    try {
      text = JSON.stringify(data);
    } catch {
      text = String(data);
    }
    this.lastToolCall = String(text).slice(0, 400);
    if (data?.name !== 'ask_user_question') return;

    let args = data.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    const questions = Array.isArray(args?.questions) ? args.questions : [];
    if (questions.length === 0) return;
    const sessionId = String(data.sessionId ?? '');
    const info = this.sessionDetails.get(sessionId);
    if (info === undefined || info.tier !== 'owner') return;
    this.questions.set(info.scene, { sessionId, callId: String(data.callId ?? ''), questions });
    this.log(`question pending in ${info.scene}: ${questions.length} question(s)`);
  }

  /**
   * Stop watching a scene.
   *
   * @param {string} scene Scene key.
   * @returns {void}
   */
  /**
   * Turn stickers off or on for one scene when the message clearly asks for it.
   *
   * @param {import('./events.js').QQMessage} message Inbound message.
   * @returns {void}
   */
  /**
   * Name a freshly created session after its conversation.
   *
   * @param {string} sessionId Session to rename.
   * @param {import('./events.js').QQMessage} message Triggering message.
   * @returns {Promise<void>} Resolves after the attempt.
   */
  async #titleSession(sessionId, message) {
    if (this.titledSessions.has(sessionId)) return;
    this.titledSessions.add(sessionId);
    const title = await this.#sceneTitle(message);
    try {
      await this.driver.rename?.(sessionId, title);
      this.log(`titled ${sessionId} as ${title}`);
    } catch (error) {
      this.titledSessions.delete(sessionId);
      this.log(`rename ${sessionId} failed: ${String(error?.message ?? error).slice(0, 120)}`);
    }
  }

  /**
   * Title text for one scene: 【私】name or 【群】name.
   *
   * @param {import('./events.js').QQMessage} message Triggering message.
   * @returns {Promise<string>} Session title.
   */
  async #sceneTitle(message) {
    if (message.kind === 'group') {
      let name = this.groupNames.get(message.groupId) ?? '';
      if (name === '') {
        try {
          const info = await this.client?.call('get_group_info', { group_id: message.groupId }, { timeoutMs: 5000 });
          name = String(info?.group_name ?? info?.data?.group_name ?? '');
          if (name !== '') this.groupNames.set(message.groupId, name);
        } catch {
          // fall back to the number
        }
      }
      return `【群】${name === '' ? message.groupId : name}`;
    }
    const name = String(message.senderName ?? '').trim();
    const who = name === '' ? String(message.senderId) : name;
    return `【私】${who}`;
  }

  #noteStickerPreference(message) {
    if (this.stickers === undefined || message.text === '') return;
    const text = message.text;
    if (wantsNoStickers(text)) {
      if (!this.stickers.isMuted(message.scene)) {
        this.stickers.mute(message.scene);
        this.log(`stickers muted in ${message.scene}`);
        void this.stickers.save().catch(() => {});
      }
      return;
    }
    if (wantsStickers(text) && this.stickers.isMuted(message.scene)) {
      this.stickers.unmute(message.scene);
      this.log(`stickers unmuted in ${message.scene}`);
      void this.stickers.save().catch(() => {});
    }
  }

  #stopQuestionPoll(scene) {
    const timer = this.questionPolls.get(scene);
    if (timer !== undefined) {
      clearInterval(timer);
      this.questionPolls.delete(scene);
    }
  }


  /**
   * Run one slash command.
   *
   * @param {any} message The inbound message.
   * @param {{ name: string, arg: string }} command Parsed command.
   * @returns {Promise<void>} Resolves after the reply is sent.
   */
  async #runCommand(message, command) {
    const scene = message.scene;
    switch (command.name) {
      case 'pause':
        this.paused = true;
        await this.sendText(message, '已暂停，接下来不回复任何消息。发 /继续 恢复。');
        return;
      case 'resume':
        this.paused = false;
        await this.sendText(message, '已恢复。');
        return;
      case 'list': {
        let items = [];
        try {
          const value = await this.controller.list({}, AbortSignal.timeout(8000));
          items = extractSessions(value);
        } catch (error) {
          await this.sendText(message, `取会话列表失败：${String(error?.message ?? error).slice(0, 140)}`);
          return;
        }
        this.sessionChoices.set(scene, items);
        const bound = this.map?.get(scene);
        const current = items.find(item => item.id === bound);
        await this.sendText(
          message,
          `${formatSessionList(items)}${current === undefined ? '' : `\n当前绑定：${current.title ?? current.id}`}`,
        );
        return;
      }
      case 'switch': {
        const items = this.sessionChoices.get(scene) ?? [];
        const index = Number(command.arg);
        const target = Number.isInteger(index) && index > 0 ? items[index - 1] : undefined;
        if (target === undefined) {
          await this.sendText(message, '先发 /列表 看看有哪些，再 /切换 序号。');
          return;
        }
        await this.map?.set(scene, target.id);
        await this.sendText(message, `已切到：${target.title ?? target.id}`);
        return;
      }
      case 'rebuild': {
        const outcome = await this.rebuildScene(scene, { reason: 'command' });
        this.sessionChoices.delete(scene);
        await this.sendText(
          message,
          outcome.recapChars === 0
            ? '已重建会话，之前的记录没有可续接的消息，下一条会开新会话。'
            : `已重建会话：带走最近 ${outcome.messages} 条消息作为摘要（${outcome.recapChars} 字），下一条消息自动接上。`,
        );
        return;
      }

      case 'new': {
        await this.#archiveReplaced(this.map?.get?.(scene));
        await this.map?.remove(scene);
        this.sessionChoices.delete(scene);
        await this.sendText(message, '下一条消息会开一个新会话。');
        return;
      }
      case 'cleanup': {
        const preview = /预览|dry/i.test(command.arg);
        const outcome = await this.cleanupSessions({ dry: preview });
        if (outcome.candidates.length === 0) {
          await this.sendText(message, `没有可清理的会话（绑定 ${outcome.bound} 个，${outcome.keepHours} 小时内活跃的都保留）。`);
          return;
        }
        if (preview) {
          const sample = outcome.candidates.slice(0, 8).map(item => `· ${item.title ?? item.id}`).join('\n');
          await this.sendText(message, `预览：可清理 ${outcome.candidates.length} 个（未执行）\n${sample}\n发 /清理会话 执行。`);
          return;
        }
        await this.sendText(message, [
          `已清理 ${outcome.archived} 个会话${outcome.failed === 0 ? '' : `（${outcome.failed} 个失败）`}。`,
          `保留：绑定中的 ${outcome.bound} 个 + ${outcome.keepHours} 小时内活跃的。文件没有删除，只是归档。`,
        ].join('\n'));
        return;
      }

      case 'digest': {
        if (this.archive === null || this.archive === undefined) {
          await this.sendText(message, '档案不可用，出不了日报。');
          return;
        }
        const scene = command.arg === '' ? message.scene : `group:${command.arg}`;
        const since = Math.floor(startOfBeijingDay() / 1000);
        let rows = [];
        try {
          rows = this.archive.search({ scene, since, limit: DIGEST_ROW_LIMIT });
        } catch (error) {
          await this.sendText(message, `读档案失败：${String(error?.message ?? error).slice(0, 140)}`);
          return;
        }
        let label = scene.startsWith('group:') ? `群 ${scene.slice(6)}` : '私聊';
        if (scene.startsWith('group:')) {
          try {
            const info = await this.client.call('get_group_info', { group_id: Number(scene.slice(6)) }, { timeoutMs: 5000 });
            const name = info?.group_name ?? info?.data?.group_name ?? '';
            if (name !== '') label = `群 ${name}`;
          } catch {
            // keep the number
          }
        }
        const dayLabel = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
        const summary = summarizeDigest(rows);
        // Same template as the memory card; text is the fallback when rendering fails.
        try {
          const payload = await renderDigestCard({
            gid: Number(scene.slice(scene.indexOf(':') + 1)),
            name: label.replace(/^群 /, ''),
            dayLabel,
            summary,
          }, { log: this.log, backdropDir: this.mediaDir });
          const inGroupMessage = message.kind === 'group';
          await this.client.call(
            inGroupMessage ? 'send_group_msg' : 'send_private_msg',
            inGroupMessage
              ? { group_id: message.groupId, message: [{ type: 'image', data: { file: payload } }] }
              : { user_id: message.peerId, message: [{ type: 'image', data: { file: payload } }] },
            { timeoutMs: 30_000 },
          );
          this.recordOutbound(message, `[图片] 群日报 ${scene}`, 'image');
        } catch (error) {
          this.log(`digest card failed, sending text: ${error?.message ?? error}`);
          await this.sendText(message, formatDigest(summary, label, dayLabel));
        }
        return;
      }
      case 'impressions': {
        await this.sendText(message, '开始补印象，可能慢（每人一次模型调用），好了我告诉你。');
        const filled = await this.backfillImpressions({ relaxed: true });
        const stats = this.impressionStats;
        const thin = Number(stats.skippedThin) || 0;
        const existing = Number(stats.skippedExisting) || 0;
        await this.sendText(message, [
          `补完：${filled} 个人拿到了印象`,
          `扫描 ${stats.scanned} 人 / 已有印象跳过 ${existing} 人 / 素材不足跳过 ${thin} 人`,
          `失败 ${stats.failed} 次${stats.lastError === '' ? '' : `（最近一次：${stats.lastError}）`}`,
          thin === 0 ? '' : '素材不足 = 发言少于 4 条或不足 120 字，等他们多说几句再补。',
        ].filter(line => line !== '').join('\n'));
        return;
      }
      case 'persona': {
        if (command.arg === '') {
          await this.sendText(message, '用法：/人设 说话简短、别客套。发 /人设 清空 可以清掉。');
          return;
        }
        const text = command.arg === '清空' || command.arg.toLowerCase() === 'clear' ? '' : command.arg;
        await this.memory?.setPersona(message.senderId, text, this.store.get().memory.personaLimit);
        await this.sendText(
          message,
          text === '' ? '已清掉你的人设，回到默认。' : '记下了，以后就按这个调子跟你说话。发 /记忆卡 看看效果。',
        );
        return;
      }
      case 'card': {
        const target = Number(command.arg) || message.senderId;
        const card = this.memory?.get(target);
        if (card === undefined) {
          await this.sendText(message, '这个人还没有记忆卡。');
          return;
        }
        // In a group, name the group on the card; a DM needs no scene tag.
        let sceneLabel = '';
        if (message.kind === 'group') {
          let groupName = '';
          try {
            const info = await this.client.call('get_group_info', { group_id: message.groupId }, { timeoutMs: 5000 });
            groupName = info?.group_name ?? info?.data?.group_name ?? '';
          } catch {
            groupName = '';
          }
          sceneLabel = groupName === '' ? `群 ${message.groupId}` : `群 · ${groupName}`;
        }
        try {
          const payload = await renderMemoryCard({
            qq: target,
            name: card.name !== undefined && card.name !== '' ? card.name : message.senderName,
            persona: card.persona?.text ?? '',
            notes: card.notes ?? [],
            admin: this.store.get().access.admins.some(admin => admin.qq === target),
            sceneLabel,
          }, { log: this.log, backdropDir: this.mediaDir });
          const inGroup = message.kind === 'group';
          await this.client.call(
            inGroup ? 'send_group_msg' : 'send_private_msg',
            inGroup
              ? { group_id: message.groupId, message: [{ type: 'image', data: { file: payload } }] }
              : { user_id: message.peerId, message: [{ type: 'image', data: { file: payload } }] },
            { timeoutMs: 30_000 },
          );
          this.recordOutbound(message, `[图片] 记忆卡 ${target}`, 'image');
        } catch (error) {
          await this.sendText(message, `记忆卡渲染失败：${String(error?.message ?? error).slice(0, 140)}`);
        }
        return;
      }
      case 'status': {
        const snapshot = this.snapshot();
        await this.sendText(message, [
          `状态：${snapshot.state}${this.paused ? '（已暂停）' : ''}`,
          `会话 ${Object.keys(this.map?.all() ?? {}).length}，场景缓冲 ${snapshot.scenes}`,
          `收到 ${snapshot.counters.messages}，回答 ${snapshot.counters.answered}，失败 ${snapshot.counters.failed}`,
        ].join('\n'));
        return;
      }
      default:
        await this.sendText(message, '不认识这个命令。');
    }
  }

  /**
   * Answer the scene's pending question from a QQ message.
   *
   * @param {any} message The inbound message.
   * @param {{ sessionId: string, callId: string, questions: any[] }} waiting The pending question.
   * @returns {Promise<boolean>} True when the message was consumed as an answer.
   */
  async #answerQuestion(message, waiting) {
    const parsed = parseReply(message.text, waiting.questions);
    if (parsed === undefined) return false;
    try {
      const accepted = this.userQuestions.answer({ id: waiting.sessionId }, waiting.callId, parsed);
      this.questions.delete(message.scene);
      if (accepted !== true) {
        await this.sendText(message, '这个选择已经过期或已经被回答了。');
        return true;
      }
      const summary = parsed.answers
        .map(item => item.custom ?? item.selected.join(' / '))
        .filter(part => part !== '')
        .join('；');
      await this.sendText(message, `已替你选：${summary || '（空）'}`);
      return true;
    } catch (error) {
      await this.sendText(message, `这个选择送不进去：${String(error?.message ?? error).slice(0, 140)}`);
      return true;
    }
  }

  /**
   * Handle one decoded OneBot event.
   *
   * @param {any} event The event.
   * @returns {Promise<void>} Resolves after the event is fully handled.
   */
  async handle(event) {
    const config = this.store.get();
    this.counters.events += 1;
    const message = normalizeEvent(event);
    if (message === undefined) return;
    // Pin the bot account: an event claiming another self_id cannot be trusted,
    // because identity comes only from the event payload.
    const seenSelf = Number(message.selfId) || 0;
    const expectedSelf = Number(config.connection.botUin) || 0;
    if (seenSelf > 0) {
      if ((expectedSelf > 0 && seenSelf !== expectedSelf) || (this.selfId !== 0 && seenSelf !== this.selfId)) {
        this.counters.ignored += 1;
        const pinned = expectedSelf > 0 ? expectedSelf : this.selfId;
        this.log(`dropped event with foreign self_id ${seenSelf} (expected ${pinned})`);
        return;
      }
      this.selfId = seenSelf;
    }

    // A person who asks for no stickers should not have to argue with a model.
    this.#noteStickerPreference(message);

    // Keep the display name next to the QQ number: the card is titled with it,
    // and the name only exists in the event payload.
    if (String(message.senderName ?? '').trim() !== '') {
      void this.memory?.setName(message.senderId, message.senderName).catch(() => {});
    }

    // Buffer before filtering: group context is made of chatter too.
    this.buffer.push(message.scene, {
      senderId: message.senderId,
      senderName: message.senderName,
      text: message.text,
      time: message.time,
      messageId: message.messageId,
      mentionsBot: message.mentionsBot,
    });

    // Archive before filtering as well: "what was said" must not depend on who
    // was allowed to answer.
    this.archive?.insert({
      key: message.key,
      selfId: message.selfId,
      kind: message.kind,
      scene: message.scene,
      peerId: message.peerId,
      groupId: message.groupId,
      senderId: message.senderId,
      senderName: message.senderName,
      time: message.time,
      text: message.text,
      messageId: message.messageId,
      replyTo: message.replyTo,
      mediaKind: mediaKindOf(message.segments),
    });

    this.counters.messages += 1;
    if (this.seen.has(message.key)) {
      this.counters.deduped += 1;
      return;
    }
    this.#remember(message.key);

    const decision = admit(message, config);
    if (decision.accepted !== true) {
      this.counters.ignored += 1;
      if (decision.reason === 'stranger-notice' && message.kind === 'dm') {
        await this.sendText(message, '这个机器人不接受陌生人的指令。');
      }
      return;
    }

    const tier = tierOf(message, config.access);

    // Slash commands run before the model, and before the pause gate.
    if (tier === 'owner') {
      const command = parseCommand(message.text);
      if (command !== undefined) {
        await this.#runCommand(message, command);
        return;
      }
    }

    // `/yes` approves the tool the model just tried to run, then the admin retries.
    // `/yes` approves the pending call; a bare yes/好 counts too while one is
    // pending, because people answer in chat rather than in commands.
    if (tier === 'owner') {
      const answer = message.text.trim();
      const broad = /^\/yes!$/i.test(answer);
      const explicit = /^\/(yes|ok|确认)$/i.test(answer);
      const casual = /^(yes|y|ok|okay|确认|批准|好|行|可以)$/i.test(answer);
      const pending = this.approvals?.pendingOf(message.scene);
      if (broad) {
        const tool = pending?.tool;
        if (tool === undefined) {
          await this.sendText(message, '先让它试一次，出现「需要管理员确认」之后再发 /yes!。');
          return;
        }
        this.approvals.grantTool(message.scene, tool, 5 * 60_000);
        await this.sendText(message, `已放行 ${tool} 5 分钟（这段时间内同类调用不用再确认）。`);
        return;
      }
      if (explicit || (casual && pending !== undefined)) {
        const approved = this.approvals?.grant(message.scene);
        const label = approved === undefined
          ? ''
          : (approved.preview === '' ? approved.tool : `${approved.tool} ${approved.preview}`);
        await this.sendText(
          message,
          approved === undefined
            ? '现在没有待确认的操作（或已超过 5 分钟，需要让它重新试一次）。'
            : `已确认 ${label}（3 分钟内有效，只批这一条）。想放开整个工具，发 /yes!`,
        );
        return;
      }
    }

    if (this.paused) {
      this.counters.ignored += 1;
      return;
    }

    // A waiting DSH question takes the next message as its answer.
    const waiting = this.questions.get(message.scene);
    if (waiting !== undefined && tier === 'owner') {
      const answered = await this.#answerQuestion(message, waiting);
      if (answered) return;
    }

    const allowance = this.quota.check(message, config.limits, tier);
    if (allowance.allowed !== true) {
      this.counters.throttled += 1;
      if (config.limits.overLimit !== 'silent') {
        await this.sendText(message, QUOTA_REPLY[allowance.reason] ?? '这条先不处理了。');
      }
      return;
    }

    const delay = config.limits.replyDelayMs + Math.round(Math.random() * config.limits.jitterMs);
    await sleep(Math.min(delay, config.limits.maxDelayMs));

    if (this.busy.has(message.scene)) {
      await this.sendText(message, '上一条还在处理，稍等一下。');
      return;
    }

    if (this.semaphore.pending >= config.limits.queueMax) {
      await this.sendText(message, '排队太长了，过一会儿再来。');
      return;
    }

    // Announce the wait *before* holding a slot: a failed send must not leak it.
    const queuePosition = this.semaphore.pending;
    if (queuePosition > 0) await this.sendText(message, `排队中，前面还有 ${queuePosition} 条。`);
    const release = await this.semaphore.acquire();
    this.quota.record(message, tier);

    this.busy.add(message.scene);
    const startedAt = Date.now();
    let replyChars = 0;
    let turnOk = false;
    try {
      if (config.output.sendProcessingHint) await this.sendText(message, '收到，正在处理…');
      if (config.output.sendTypingStatus) await this.setTyping(message, true);
      // Let the desktop pet react, without ever blocking the turn on it.
      void this.pet?.say(`${message.senderName}：${message.text.slice(0, 40)}`);
      void this.pet?.workStatus('working', `${message.scene}`);
      if (tier !== 'owner') await this.#maybeBackfill(message);
      const injection = this.#injectionFor(message.scene);
      const card = this.#cardBlock(message, injection);
      const { parts: images, originals, sheets } = await promptImageParts(message.segments, this.log);
      const savedPaths = [];
      const quoted = await this.#resolveQuote(message);
      // "啥意思" with no quote most likely points at my own previous reply.
      const shortAsk = message.text.trim() !== '' && message.text.trim().length <= 6 && message.replyTo === undefined;
      const remembered = this.lastReply.get(message.scene);
      const quotedText = quoted?.text
        ?? (shortAsk && remembered !== undefined ? `（我上一条说）${remembered.slice(0, 200)}` : undefined);
      // A rebuilt scene (marked earlier, possibly before a restart) carries its
      // tail exactly once. The same rows were just backfilled into the buffer,
      // so mark them seen to keep the context window free of duplicates.
      let seed;
      const mark = this.rebuildMarks.get(message.scene);
      if (mark !== undefined) {
        this.rebuildMarks.delete(message.scene);
        void this.#saveRebuildMarks().catch(() => {});
        const rows = this.archive?.search?.({ scene: message.scene, limit: 14 }) ?? [];
        for (const row of rows) {
          injection.seen.add(entrySignature({ time: Number(row.time_unix) || 0, senderId: Number(row.sender_id) || 0, text: row.text ?? '' }));
        }
        seed = formatRecap(rows);
      }
      const promptBase = tier === 'owner'
        ? this.#privatePrompt(message, config, card, quotedText)
        : this.#groupPrompt(message, config, card, quotedText, injection);
      const stickers = imageSegments(message.segments).filter(looksLikeSticker).length;
      // Voice: QQ's own ASR first, then a local speech provider, then a command.
      const voices = voiceSegments(message.segments);
      let voiceNote = '';
      if (voices.length > 0 && config.voice?.enabled !== false) {
        let voiceError = '';
        const transcripts = [];
        const sources = new Set();
        for (const voice of voices) {
          const result = await transcribeVoice({
            client: this.client,
            speech: this.speech,
            segment: voice,
            messageId: message.messageId,
            config: config.voice,
            log: this.log,
          });
          if (result === undefined || result.text === undefined) {
            if (result?.error !== undefined) voiceError = String(result.error).slice(0, 120);
            continue;
          }
          transcripts.push(result.text);
          sources.add(result.source);
        }
        const via = sources.size === 0 ? '' : `（${[...sources].map(source => ({ speech: '本地模型', command: '外部命令', qq: 'QQ 识别' })[source] ?? source).join(' / ')}）`;
        voiceNote = transcripts.length === 0
          ? `\n\n（收到 ${voices.length} 条语音，转写不可用${voiceError === '' ? '' : `：${voiceError}`}）`
          : `\n\n（语音转写${via}：${transcripts.join(' / ')}）`;
      }
      // Received files: download into the media directory so the model can open them.
      const files = fileSegments(message.segments);
      let fileNote = '';
      if (files.length > 0) {
        const savedFiles = [];
        for (const file of files) {
          try {
            const path = await fetchInboundFile(this.client, file, this.mediaDir, this.log);
            if (path !== undefined) savedFiles.push(path);
          } catch (error) {
            this.log(`file download failed: ${error?.message ?? error}`);
          }
        }
        fileNote = savedFiles.length === 0
          ? `\n\n（收到 ${files.length} 个文件，未能下载）`
          : `\n\n（收到文件，已存到这些路径）\n${savedFiles.join('\n')}`;
      }

      // A merged forward is only an id in the segment; fetch its content so the
      // model can read what was forwarded instead of seeing "[聊天记录]".
      const forwarded = await fetchForwards(this.client, message.segments, this.log);
      const forwardText = forwarded.text;
      // Images contained in the forward ride along as real pictures, capped so a
      // forwarded album cannot blow the per-turn image budget.
      const forwardedImages = forwarded.images.length === 0
        ? { parts: [], originals: [], sheets: [] }
        : await promptImageParts(forwarded.images, this.log, Math.max(0, 4 - images.length));
      images.push(...forwardedImages.parts);
      originals.push(...forwardedImages.originals);
      // Pictures attached to the quoted message (or inside the quoted forward)
      // follow the same path, so "引用那条转发" can actually show the images.
      const quoteImages = (quoted?.images ?? []).length === 0
        ? { parts: [], originals: [] }
        : await promptImageParts(quoted.images, this.log, Math.max(0, 4 - images.length));
      images.push(...quoteImages.parts);
      originals.push(...quoteImages.originals);
      if (quoteImages.parts.length > 0) {
        this.log(`quote images attached: ${quoteImages.parts.length}`);
      }
      if (config.archive.media === true && this.mediaDir !== '' && originals.length > 0) {
        for (const image of originals) {
          try {
            savedPaths.push(await persistImage(image, this.mediaDir));
          } catch (error) {
            this.log(`image archive failed: ${error?.message ?? error}`);
          }
        }
      }
      // Keep the paths on the archived row so a later history review can open
      // the actual image instead of guessing from a [图片] placeholder.
      if (savedPaths.length > 0) this.archive?.attachMedia?.(message.key, savedPaths.join(';'));
      const savedNote = savedPaths.length === 0 ? '' : `；已存档：${savedPaths.join('、')}`;
      const gifNote = sheets.length === 0
        ? ''
        : `；${sheets.map(sheet => `动图取 ${sheet.frames}/${sheet.total} 帧拼成 3×3`).join('，')}`;
      const imageNote = images.length === 0
        ? ''
        : `\n\n（这条消息附了 ${images.length} 张图片${stickers > 0 ? `，其中 ${stickers} 张是表情包，多半是语气` : ''}${gifNote}${savedNote}）`;
      const forwardImageNote = forwardedImages.parts.length === 0
        ? ''
        : `\n（转发里另有 ${forwardedImages.parts.length} 张图片，见附件）`;
      const forwardNote = forwardText === '' && forwardImageNote === ''
        ? ''
        : `\n\n（对方转发了一段聊天记录）\n${forwardText}${forwardImageNote}`;
      // Every Nth answered turn, ask for one fresh impression.
      const turnNumber = (this.turnCounts.get(message.senderId) ?? 0) + 1;
      this.turnCounts.set(message.senderId, turnNumber);
      const nudge = dueForAutoNote(turnNumber, config.memory.autoNoteEvery) ? autoNotePrompt() : '';
      // Sticker catalog: only when the tool is available for this tier.
      const stickerNote = this.stickerBlock(message.scene, injection);
      // Reply length: asked once per session; the image path enforces it.
      const lengthLimit = Number(config.output.maxReplyChars) || 0;
      const lengthNote = lengthLimit > 0
        ? injection.fixed('length', `【回复长度】尽量控制在 ${lengthLimit} 字以内；内容较长时正常输出，我会自动转成图片发出去。`)
        : '';
      const bodyText = `${promptBase}${imageNote}${voiceNote}${fileNote}${forwardNote}${stickerNote}${lengthNote}${nudge}`;
      const text = seed === undefined ? bodyText : `${seed}\n\n${bodyText}`;
      this.contextStats = { chars: text.length, ...injection.stats };
      if (injection.skipped > 0) {
        this.log(`context ${message.scene}: sent ${text.length} chars, skipped ${injection.skipped}`);
      }
      // The body was checked at admission; the quote, forward, transcript and
      // file names only exist now, so scan the assembled prompt as well.
      const hit = blockedWord(bodyText, config);
      if (hit !== '') {
        this.counters.ignored += 1;
        this.log(`blocked word in merged content for ${message.scene}: ${hit}`);
        return;
      }

      const cardsBefore = this.cardsSent;
      const result = await this.driver.ask({
        scene: message.scene,
        text,
        content: [{ type: 'text', text }, ...images],
        cwd: config.conversation.cwd,
        timeoutMs: config.limits.turnTimeoutMs,
        tier,
        onSession: sessionId => {
          const tracker = this.injections.get(message.scene);
          if (tracker !== undefined) tracker.sessionId = String(sessionId);
          this.senders.set(sessionId, message.senderId);
          this.sessionDetails.set(sessionId, { qq: message.senderId, scene: message.scene, tier });
          // While this turn runs, watch for questions the Host is waiting on.
          this.#startQuestionPoll(message, sessionId);
          // Name the session after the conversation, once per session.
          void this.#titleSession(sessionId, message);
        },
      });
      // A card is the answer: drop the "已发送" text that usually follows it.
      const cardSent = this.cardsSent > cardsBefore;
      if (shouldStaySilent(result.text, { cardSent })) {
        this.counters.answered += 1;
        turnOk = true;
        this.log(`answered ${message.scene} (${tier}) with a card only${result.text.trim() === '' ? '' : `, dropped "${result.text.trim().slice(0, 40)}"`}`);
        void this.pet?.workStatus('success');
        return;
      }
      const body = result.text.trim() === '' ? '（这轮没有文本回复）' : result.text.trim();
      const limitCandidates = [config.output.imageThreshold, config.output.maxReplyChars]
        .map(value => Number(value) || 0)
        .filter(value => value > 0);
      const replyLimit = limitCandidates.length > 0 ? Math.min(...limitCandidates) : Number.MAX_SAFE_INTEGER;
      const asImage = body.length > replyLimit
        ? await this.sendLongReply(message, body, config, result.reasoning)
        : false;
      if (!asImage) {
        for (const chunk of chunkText(body, CHUNK_LIMIT)) {
          await this.sendText(message, chunk, { record: false });
          await sleep(250);
        }
        this.recordOutbound(message, body, undefined, result.reasoning);
      }
      this.counters.answered += 1;
      this.lastReply.set(message.scene, body);
      replyChars = body.length;
      turnOk = true;
      this.log(`answered ${message.scene} (${tier}) via ${result.sessionId}${asImage ? ' as image' : ''}`);
      void this.pet?.workStatus('success');
    } catch (error) {
      this.counters.failed += 1;
      this.log(`turn failed for ${message.scene}: ${error?.message ?? error}`);
      void this.pet?.workStatus('error');
      await this.sendText(message, `我这边出错了：${String(error?.message ?? error).slice(0, 200)}`);
    } finally {
      this.archive?.insertTurn({
        scene: message.scene,
        senderId: message.senderId,
        tier,
        startedAt,
        durationMs: Date.now() - startedAt,
        promptChars: message.text.length,
        replyChars,
        ok: turnOk,
      });
      release();
      this.#stopQuestionPoll(message.scene);
      if (this.store.get().output.sendTypingStatus) void this.setTyping(message, false);
      this.busy.delete(message.scene);
      if (this.busy.size === 0) setTimeout(() => void this.pet?.workStatus('idle'), 4000)?.unref?.();
    }
  }

  /**
   * Show or clear the QQ "typing" state.
   *
   * Only private chats expose it; a group has no equivalent, so this is a no-op
   * there. Failures are cosmetic and never fail the turn.
   *
   * @param {import('./events.js').QQMessage} message The message being answered.
   * @param {boolean} on True to start typing, false to stop.
   * @returns {Promise<void>} Resolves after the best-effort call.
   */
  async setTyping(message, on) {
    if (this.client === undefined || message.kind !== 'dm') return;
    try {
      await this.client.call('set_input_status', { user_id: message.peerId, event_type: on ? 1 : 0 }, { timeoutMs: 5000 });
    } catch (error) {
      this.log(`typing status failed: ${error?.message ?? error}`);
    }
  }

  /**
   * Memory card block for the person who just spoke.
   *
   * @param {import('./events.js').QQMessage} message The message.
   * @returns {string} The block, or an empty string when the card is empty.
   */
  /**
   * Drop a scene's session and hand its tail to the next message.
   *
   * @param {string} scene Scene key.
   * @param {{ reason?: string, limit?: number }} [options] Wiring.
   * @returns {Promise<{ recapChars: number, messages: number }>} What was carried over.
   */
  /**
   * Hide a session the bridge replaced, best effort.
   *
   * @param {string | undefined} sessionId Old binding.
   * @returns {Promise<void>} Resolves after the attempt.
   */
  async #archiveReplaced(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    if (this.store.get().conversation.archiveOldSessions === false) return;
    try {
      await this.archiveSession?.(sessionId);
      this.log(`archived replaced session ${sessionId}`);
    } catch (error) {
      this.log(`archive ${sessionId} failed: ${String(error?.message ?? error).slice(0, 100)}`);
    }
  }

  /**
   * Archive sessions the bridge no longer needs.
   *
   * Keeps every bound session, anything running, anything touched inside the
   * retention window and anything outside the bridge folder; the rest is
   * archived (files stay on disk).
   *
   * @param {{ dry?: boolean }} [options] When dry, only count.
   * @returns {Promise<{ keepHours: number, bound: number, candidates: Array<{ id: string, title?: string, updatedAt?: number }>, archived: number, failed: number, dry: boolean }>} Outcome.
   */
  async cleanupSessions(options = {}) {
    const config = this.store.get();
    const keepHours = Math.max(1, Number(config.conversation.cleanupKeepHours) || 24);
    const items = extractSessions(await this.controller.list({}, AbortSignal.timeout(8000)));
    const bound = Object.values(this.map?.all?.() ?? {});
    const candidates = cleanupCandidates(items, {
      bound: new Set(bound),
      keepMs: keepHours * 3600_000,
      cwd: config.conversation.cwd,
    }).map(item => ({ id: item.id, title: item.title, updatedAt: item.updatedAt }));
    if (options.dry === true) {
      return { keepHours, bound: bound.length, candidates, archived: 0, failed: 0, dry: true };
    }
    let archived = 0;
    let failed = 0;
    for (const item of candidates) {
      try {
        await this.archiveSession?.(item.id);
        archived += 1;
      } catch {
        failed += 1;
      }
    }
    if (archived > 0) this.log(`archived ${archived} stale sessions`);
    return { keepHours, bound: bound.length, candidates, archived, failed, dry: false };
  }

  async rebuildScene(scene, options = {}) {
    const rows = this.archive?.search?.({ scene, limit: Math.max(1, options.limit ?? 14) }) ?? [];
    const recap = formatRecap(rows);
    const previous = this.map?.get?.(scene);
    await this.map?.remove?.(scene);
    await this.#archiveReplaced(previous);
    this.injections.delete(scene);
    if (recap !== '') {
      this.rebuildMarks.set(scene, { at: Date.now() });
      await this.#saveRebuildMarks();
    }
    this.log(`rebuilt ${scene} (${options.reason ?? 'manual'}): will carry ${recap.length} chars`);
    return { recapChars: recap.length, messages: rows.length };
  }

  /**
   * Rebuild every chat scene whose saved session is bigger than the budget.
   *
   * Called once at startup: a session that already carries hundreds of KB of
   * history would keep costing that on every turn.
   *
   * @param {number} limitKb Threshold in kilobytes; 0 disables the pass.
   * @returns {Promise<Array<{ scene: string, chars: number }>>} What was rebuilt.
   */
  async autoRebuildSessions(limitKb) {
    const limit = Number(limitKb) || 0;
    await this.map?.load?.();
    if (limit <= 0) return [];
    const rebuilt = [];
    const entries = Object.entries(this.map?.all?.() ?? {});
    for (const [scene, sessionId] of entries) {
      const lastAuto = this.autoRebuiltAt.get(scene) ?? 0;
      if (Date.now() - lastAuto < 6 * 3600_000) continue;
      if (!scene.startsWith('dm:') && !scene.startsWith('group:')) continue;
      let chars = 0;
      try {
        const inspection = await this.controller?.inspect?.(sessionId);
        for (const event of inspection?.events ?? []) chars += JSON.stringify(event).length;
      } catch (error) {
        this.log(`inspect ${scene} failed: ${error?.message ?? error}`);
        continue;
      }
      if (chars < limit * 1024) continue;
      const result = await this.rebuildScene(scene, { reason: 'auto', limit: 14 });
      this.autoRebuiltAt.set(scene, Date.now());
      rebuilt.push({ scene, chars, kept: result.recapChars });
    }
    if (rebuilt.length > 0) this.log(`auto rebuild: ${rebuilt.map(item => `${item.scene} ${Math.round(item.chars / 1024)}KB->${item.kept} chars`).join(', ')}`);
    return rebuilt;
  }

  /**
   * Load rebuild marks that survived a restart.
   *
   * @returns {Promise<void>} Resolves after the read.
   */
  /**
   * Load the rebuild marks saved by a previous run.
   *
   * @returns {Promise<void>} Resolves after the read.
   */
  async loadRebuildState() {
    await this.#loadRebuildMarks();
  }

  async #loadRebuildMarks() {
    if (this.stateDir === '') return;
    try {
      const parsed = JSON.parse(await readFile(join(this.stateDir, 'rebuilds.json'), 'utf8'));
      for (const [scene, mark] of Object.entries(parsed ?? {})) {
        if (typeof mark?.at === 'number') this.rebuildMarks.set(scene, { at: mark.at });
      }
    } catch {
      // Missing or unreadable simply starts empty.
    }
  }

  /**
   * Persist rebuild marks.
   *
   * @returns {Promise<void>} Resolves after the write.
   */
  async #saveRebuildMarks() {
    if (this.stateDir === '') return;
    const body = JSON.stringify(Object.fromEntries(this.rebuildMarks), null, 2);
    const target = join(this.stateDir, 'rebuilds.json');
    await mkdir(this.stateDir, { recursive: true });
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, target);
  }
  /**
   * Injection state for one scene; a new session starts from scratch.
   *
   * @param {string} scene Scene key.
   * @returns {InjectionTracker} Tracker for this scene.
   */
  #injectionFor(scene) {
    // /新建 or a lost session replaces the binding; the new session has not seen
    // any block yet, so drop the old tracker.
    const bound = String(this.map?.get?.(scene) ?? '');
    const existing = this.injections.get(scene);
    if (existing !== undefined && existing.sessionId !== bound) {
      this.injections.delete(scene);
    }
    if (existing !== undefined) return existing;
    const fresh = new InjectionTracker();
    fresh.sessionId = String(this.map?.get?.(scene) ?? '');
    // The binding may only appear after this turn creates the session; record it
    // lazily so the first turn's blocks are not re-sent next time.
    this.injections.set(scene, fresh);
    return fresh;
  }

  #cardBlock(message, injection) {
    if (this.memory === undefined) return '';
    const card = this.memory.get(message.senderId);
    return injection.fixed('card', renderCard({ card, name: message.senderName, qq: message.senderId }));
  }

  /**
   * Prompt text for a private owner chat: the message itself.
   *
   * @param {import('./events.js').QQMessage} message The message.
   * @param {import('../config/defaults.js').QQConfig} config Live configuration.
   * @param {string} [card] Memory card block for the sender.
   * @returns {string} Prompt text.
   */
  #privatePrompt(message, config, card = '', quotedText) {
    const text = message.text === '' ? '（发送了非文本消息）' : message.text;
    const body = text.slice(0, config.limits.maxInputChars);
    const quote = quotedText === undefined ? '' : `\n\n（他引用了这条消息）\n${quotedText}`;
    return card === '' ? `${body}${quote}` : `${card}\n\n${body}${quote}`;
  }

  /**
   * Resolve the message this one quotes.
   *
   * The scene buffer only knows messages seen while connected, and a merged
   * forward is stored there as the bare "[聊天记录]" placeholder. Both cases are
   * answered by asking QQ for the quoted message, then expanding any forward it
   * contains.
   *
   * @param {import('./events.js').QQMessage} message The triggering message.
   * @returns {Promise<{ text: string, images: Array<{ type: 'image', data: Record<string, unknown> }> } | undefined>} Quote text plus any images it carried, or undefined when nothing is quoted.
   */
  async #resolveQuote(message) {
    if (message.replyTo === undefined) return undefined;
    const cached = this.buffer.find(message.scene, message.replyTo);
    const placeholder = cached !== undefined && /^\[(聊天记录|图片|文件|视频|语音)\]$/.test(cached.text.trim());
    if (cached !== undefined && !placeholder) return { text: `${cached.senderName}: ${cached.text}`, images: [] };
    if (this.client === undefined) {
      return cached === undefined ? undefined : { text: `${cached.senderName}: ${cached.text}`, images: [] };
    }

    try {
      const raw = await this.client.call('get_msg', { message_id: Number(message.replyTo) }, { timeoutMs: 8000 });
      const segments = raw?.message ?? raw?.data?.message ?? [];
      // The quoted message can be a plain image, or a forward full of images:
      // both must reach the prompt as real pictures, not as placeholders.
      const ownImages = Array.isArray(segments)
        ? segments.filter(segment => segment?.type === 'image' && typeof segment?.data?.url === 'string')
        : [];
      const forwarded = await fetchForwards(this.client, segments, this.log);
      const flat = Array.isArray(segments)
        ? segments.map(segment => segment?.data?.text ?? '').join('')
        : '';
      const body = forwarded.text !== '' ? forwarded.text : flat.trim();
      const sender = raw?.sender?.card || raw?.sender?.nickname || cached?.senderName || '对方';
      const images = [...ownImages, ...forwarded.images].slice(0, 4);
      if (body !== '' || images.length > 0) {
        const text = body === '' ? `${sender}:（引用的是图片）` : `${sender}: ${body.slice(0, 1500)}`;
        return { text, images };
      }
    } catch (error) {
      this.log(`quote lookup failed for ${message.replyTo}: ${error?.message ?? error}`);
    }
    return cached === undefined ? undefined : { text: `${cached.senderName}: ${cached.text}`, images: [] };
  }

  /**
   * Seed the scene buffer from QQ's own history when it is thin.
   *
   * The bridge only sees messages that arrive while it is connected, so after a
   * restart the first mention would otherwise be answered with no context.
   *
   * @param {import('./events.js').QQMessage} message The triggering message.
   * @returns {Promise<void>} Resolves after the attempt.
   */
  async #maybeBackfill(message) {
    if (this.client === undefined || message.kind !== 'group') return;
    if (this.buffer.recent(message.scene, 20).length >= 20) return;
    const last = this.backfilled.get(message.scene) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.backfilled.set(message.scene, Date.now());
    try {
      const count = Math.max(20, this.store.get().conversation.groupHistory);
      const data = await this.client.call(
        'get_group_msg_history',
        { group_id: message.groupId, count },
        { timeoutMs: 8000 },
      );
      const items = Array.isArray(data?.messages) ? data.messages : [];
      /** @type {Array<import('../context/buffer.js').BufferEntry>} */
      const entries = [];
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue;
        const senderId = Number(item.user_id ?? item.sender?.user_id ?? 0);
        const senderName = String(item.sender?.card || item.sender?.nickname || item.user_id);
        const time = Number(item.time) || 0;
        const messageId = Number(item.message_id);
        const { text, mentionsBot } = flattenSegments(item.message ?? [], message.selfId);
        entries.push({ senderId, senderName, text, time, messageId, mentionsBot });
        // The archive gets the same history, so "what was said" survives restarts.
        this.archive?.insert({
          key: `${message.selfId}:${messageId}`,
          selfId: message.selfId,
          kind: message.kind,
          scene: message.scene,
          peerId: message.peerId,
          groupId: message.groupId,
          senderId,
          senderName,
          time,
          text,
          messageId,
          replyTo: undefined,
          mediaKind: mediaKindOf(item.message ?? []),
        });
      }
      this.buffer.merge(message.scene, entries);
      this.log(`backfilled ${entries.length} messages for ${message.scene}`);
    } catch (error) {
      this.log(`backfill failed for ${message.scene}: ${error?.message ?? error}`);
    }
  }

  /**
   * Prompt text for a group turn: bounded context plus the addressed question.
   *
   * @param {import('./events.js').QQMessage} message The message.
   * @param {import('../config/defaults.js').QQConfig} config Live configuration.
   * @returns {string} Prompt text.
   */
  #groupPrompt(message, config, card = '', quotedText, injection) {
    const window = Math.max(1, config.conversation.groupHistory);
    // The session already holds what earlier turns injected, so only messages
    // that appeared since then are worth sending again.
    const entries = injection.delta(this.buffer.recent(message.scene, window + 1).slice(0, -1));
    const cached = message.replyTo === undefined ? undefined : this.buffer.find(message.scene, message.replyTo);
    const quoted = quotedText ?? (cached === undefined ? undefined : `${cached.senderName}: ${cached.text}`);
    const block = renderContext({
      entries,
      quoted,
      maxChars: config.conversation.groupCharCap,
    });
    // Everyone in a group shares one session, so the window also contains what
    // other members said. Use it to understand the conversation, not to report it.
    const privacy = config.conversation.groupPrivacy === false
      ? ''
      : injection.fixed('rules', '【群聊规则】上下文里其他成员的消息只用于理解你们在聊什么，不要复述、总结、转述或引用其中任何一句；被问到“别人说了什么”时，只回答你自己看到的本轮内容。');
    const ask = `【当前提问】${message.senderName}(${message.senderId}): ${message.text === '' ? '（非文本消息）' : message.text}`;
    const parts = [card, block, privacy, ask].filter(part => part !== '');
    return parts.join('\n\n');
  }

  /**
   * Send a long reply as a rendered PNG.
   *
   * @param {import('./events.js').QQMessage} message The message being answered.
   * @param {string} body Full reply text.
   * @param {import('../config/defaults.js').QQConfig} config Live configuration.
   * @returns {Promise<boolean>} True when the picture was delivered.
   */
  async sendLongReply(message, body, config, reasoning) {
    if (this.client === undefined) return false;
    try {
      const payload = await renderTextImageBase64({
        text: body,
        outPath: join(tmpdir(), `dsh-to-qq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`),
        style: config.output.style,
        width: config.output.width,
        fontSize: config.output.fontSize,
      });
      const action = message.kind === 'dm' ? 'send_private_msg' : 'send_group_msg';
      const params = message.kind === 'dm'
        ? { user_id: message.peerId, message: [{ type: 'image', data: { file: payload } }] }
        : { group_id: message.groupId, message: [{ type: 'image', data: { file: payload } }] };
      await this.client.call(action, params, { timeoutMs: 30_000 });
      this.recordOutbound(message, `[图片] 长回复 ${body.length} 字`, 'image', reasoning);
      return true;
    } catch (error) {
      this.log(`image reply failed, falling back to text: ${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * Send one plain-text reply to the message's scene.
   *
   * @param {import('./events.js').QQMessage} message The message being answered.
   * @param {string} text Reply body.
   * @param {{ record?: boolean }} [options] Set `record: false` when the caller archives the whole reply itself.
   * @returns {Promise<void>} Resolves after the action returns.
   */
  async sendText(message, text, options = {}) {
    if (this.client === undefined) return;
    const action = message.kind === 'dm' ? 'send_private_msg' : 'send_group_msg';
    const params = message.kind === 'dm'
      ? { user_id: message.peerId, message: [{ type: 'text', data: { text } }] }
      : { group_id: message.groupId, message: [{ type: 'text', data: { text } }] };
    try {
      await this.client.call(action, params, { timeoutMs: 10_000 });
      if (options.record !== false) this.recordOutbound(message, text);
    } catch (error) {
      this.counters.errors += 1;
      this.log(`reply failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Store our own message in the archive so the panel can render both sides.
   *
   * @param {import('./events.js').QQMessage} message The message being answered.
   * @param {string} text What we sent.
   * @param {string} [mediaKind] Set when the body was an image.
   * @param {string} [reasoning] The model's reasoning for this reply.
   */
  recordOutbound(message, text, mediaKind, reasoning) {
    if (this.archive === null || this.archive === undefined) return;
    this.outSeq = (this.outSeq ?? 0) + 1;
    this.archive.insert({
      key: `${message.selfId}:out:${Date.now()}:${this.outSeq}`,
      selfId: message.selfId,
      kind: message.kind,
      scene: message.scene,
      peerId: message.peerId,
      groupId: message.groupId,
      senderId: message.selfId,
      senderName: 'DSH',
      time: Math.floor(Date.now() / 1000),
      text,
      messageId: 0,
      direction: 'out',
      mediaKind,
      reasoning,
    });
  }

  /**
   * Remember a message key, evicting the oldest when the window is full.
   *
   * @param {string} key Dedupe key.
   */
  #remember(key) {
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > SEEN_LIMIT) {
      const evicted = this.seenOrder.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }
}



























