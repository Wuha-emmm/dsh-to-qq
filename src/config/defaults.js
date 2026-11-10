/**
 * Default runtime configuration for dsh-to-qq.
 *
 * The settings page writes this shape to `config.json`; nothing here depends on
 * `@deepseek-ai/schemastery`, because a profile-installed plugin cannot resolve
 * DSH packages. Validation is therefore local and explicit.
 */

/** @typedef {ReturnType<typeof defaults>} QQConfig */

/** Fixed, non-configurable product rules. Surfaced in the settings UI as locked rows. */
const LOCKED = {
  /** Group chats never write to, or execute on, the host. */
  groupReadOnly: true,
  /** Text from anyone in a group is untrusted input, never an instruction. */
  groupTextUntrusted: true,
  /** Settings change only in the local DSH UI, never over QQ. */
  settingsLocalOnly: true,
  /** The overlay starts collapsed. */
  overlayCollapsed: true,
};

/** @returns {QQConfig} A fresh default configuration. */
export function defaults() {
  return {
    connection: {
      enabled: true,
      httpUrl: 'http://127.0.0.1:3000',
      wsUrl: 'ws://127.0.0.1:3001',
      eventPath: '/',
  /** Bot QQ number; 0 = learn from the first event, then pin it. */
  botUin: 0,
      token: '',
      /** HTTP and WebSocket adapters may use different tokens (SnowLuma does). */
      httpToken: '',
  /** Read the token from this environment variable instead of the config file. */
  tokenEnv: '',
  /** Environment variable for the HTTP token; falls back to tokenEnv. */
  httpTokenEnv: '',
      /** Start SnowLuma on demand when nothing answers the HTTP endpoint. */
      autoStart: true,
      /** SnowLuma install directory; empty disables auto-start. */
      snowlumaDir: '',
      /** SnowLuma console URL, opened by the settings page. */
      snowlumaWebui: 'http://127.0.0.1:5099',
      reconnect: { enabled: true, baseMs: 1000, maxMs: 30000 },
    },
    access: {
      /** @type {{ qq: number, name: string, addedAt: number }[]} */
      admins: [],
      /** ignore | notice | block */
      strangerPolicy: 'ignore',
      /** Treat the bot's QQ friends (non-admin DMs) as members instead of strangers. */
      friendsAsMember: true,
      /** Forward friend/group requests to the administrators for an answer. */
      forwardRequests: true,
      /** How long a forwarded request stays answerable, in minutes. */
      requestTtlMin: 30,
      /** whitelist | blacklist | all */
      groupMode: 'whitelist',
      /** @type {number[]} */
      groups: [],
      mentionOnly: true,
      /** @type {string[]} */
      blockedWords: [],
    },
    models: {
      /** CNY per successful web_search / web_fetch call. */
      searchPrice: 0.005,
      fetchPrice: 0.005,
      /** Off-peak prices are this fraction of the peak ones (DeepSeek: 0.5). */
      offPeakDiscount: 0.5,
      /** Off-peak window in local time; empty disables the discount. */
      peakWindows: '09:00-12:00,14:00-18:00',
      /** YYYY-MM-DD, comma separated; those days are billed off-peak all day. */
      peakHolidays: '',
      /** ¥ per 1M tokens; all zero means "not configured" and the panel shows tokens only. */
      inputPrice: 2,
      outputPrice: 8,
      cachePrice: 0.04,
      /** Permission preset applied to each QQ session; empty leaves the deployment default. */
      permissionPreset: 'danger-full-access',
      owner: { provider: '', model: '', effort: 'high' },
      member: { provider: '', model: '', effort: '' },
      summarizer: { provider: '', model: '', effort: '' },
    },
    conversation: {
      /** Workspace directory for sessions created for a QQ scene; empty = DSH default. */
      cwd: '',
      /** owner private chats are intentionally unbounded; shown locked in the UI. */
      groupHistory: 99,
      groupCharCap: 6000,
  /** Sessions idle for fewer hours than this are never cleaned up. */
  cleanupKeepHours: 24,
  /** Archive the session a rebuild replaces, so the sidebar does not grow forever. */
  archiveOldSessions: true,
  /** Rebuild a saved session bigger than this many KB automatically; 0 = off (use /重建). */
  autoRebuildKb: 0,
  /** Tell the model not to repeat what other group members said. */
  groupPrivacy: true,
    },
    memory: {
      /** Drop credentials, remote-control and capture facts from memory notes. */
      redactSensitive: true,
      /** Extra words that make a note too sensitive to keep. */
      sensitiveWords: [],
      summaryLimit: 1000,
      personaLimit: 1000,
      autoNoteEvery: 8,
      impressionsEnabled: true,
      impressionEvery: 100,
      impressionMinChars: 800,
      impressionBudget: 600,
    },
    accounts: {
      /** Chromium executable for the sign-in window; empty auto-detects Edge/Chrome. */
      browserPath: '',
      /** DevTools port the sign-in window listens on; cookies are read from it. */
      debugPort: 9333,
    },
    limits: {
      memberDaily: 100,
      groupDaily: 400,
      userPerMinute: 8,
      maxInputChars: 2000,
      concurrency: 4,
      queueMax: 10,
      turnTimeoutMs: 180000,
      turnIdleMs: 300000,
      replyDelayMs: 2000,
      jitterMs: 1500,
      maxDelayMs: 15000,
      /** Hard ceiling on how long a reply is held while follow-ups collect. */
      batchMaxWaitMs: 7000,
      /** refuse | silent | queue */
      overLimit: 'refuse',
    },
    output: {
      imageThreshold: 500,
  /** The model is asked to stay within this many characters; longer replies render as an image. 0 = no hint. */
  maxReplyChars: 250,
  /** Per-scene reply limits; 0 falls back to maxReplyChars. */
  replyCharsOwner: 400,
  replyCharsGroup: 300,
      /** light | dark | bubble */
      style: 'light',
      fontSize: 22,
      width: 1080,
      /** Send a "收到，正在处理…" chat message before the turn. Off by default. */
      sendProcessingHint: false,
      /** Show the QQ "typing" state instead: no bubble, same feedback. */
      sendTypingStatus: true,
      /**
       * In a group, open each text reply with an @ to the person being answered.
       * Shared group sessions make "who is this for" ambiguous when several
       * people ask at once; the mention makes it explicit.
       */
      groupAtReply: true,
    },
    archive: {
      enabled: true,
      /** Persist inbound images so a later history review can open them. */
  media: true,
      retentionDays: 30,
  /** Media files age out faster than the rows that reference them. */
  mediaRetentionDays: 7,
    },
    backup: {
      /** Snapshot the state directory once a day, without being asked. */
      auto: true,
      /** How many automatic backups to keep; manual ones are never pruned. */
      keep: 7,
      /** Include sticker previews and saved attachments (larger, slower). */
      includeMedia: false,
      /** Include signed-in account cookies so a new machine stays logged in. */
      includeCookies: true,
    },
    stickers: {
      /** Offer the sticker catalog to the model and allow sending. */
      enabled: true,
      /** How many stickers one prompt lists. */
      inPrompt: 24,
      /** Upper bound of stickers one conversation may receive per hour. */
      perHourPerScene: 3,
      /** How many missing descriptions one sync tries to learn. */
      describeBatch: 20,
    },
    voice: {
      enabled: true,
      /** Recognition language passed to speech providers and command templates. */
      language: 'zh',
      /** Command template with {input} / {language}; empty means no local engine. */
      command: '',
      /** QQ native speech-to-text, tried before any local model. */
      qqAsr: true,
    },
    digest: {
      enabled: false,
      hour: 22,
      minute: 0,
      groups: [],
    },
    safety: {
      confirmWrite: true,
      confirmTtlMs: 180_000,
      /** How long `/yes!` and `/全放行` keep a tool open; long tasks need more than five minutes. */
      toolGrantMinutes: 15,
      audit: true,
    },
    appearance: {
      /** '', `preset:<id>`, or the uploaded panel background URL. */
      background: '',
      /** How much of the theme background is laid over the picture, in percent. */
      backgroundDim: 55,
      /** Gaussian blur applied to the picture, in pixels. */
      backgroundBlur: 0,
    },
  };
}

/** Values the panel may store for the conversation background. */
const BACKGROUND_PATTERN = /^(?:|preset:[a-z0-9-]{1,24}|\/dsh-to-qq\/api\/panel\/background\?v=\d{1,16})$/;

/** Ranges enforced by `normalize`; every entry is `[min, max]`. */
export const RANGES = {
  'conversation.groupHistory': [0, 200],
  'conversation.groupCharCap': [500, 40000],
  'memory.summaryLimit': [200, 4000],
      'memory.autoNoteEvery': [0, 100],
      'memory.impressionEvery': [20, 1000],
      'memory.impressionMinChars': [100, 5000],
      'memory.impressionBudget': [200, 2000],
  'memory.personaLimit': [100, 4000],
  'limits.memberDaily': [0, 10000],
  'limits.groupDaily': [0, 100000],
  'limits.userPerMinute': [1, 30],
  'limits.maxInputChars': [200, 20000],
  'limits.concurrency': [1, 5],
  'limits.queueMax': [1, 50],
  'stickers.inPrompt': [0, 60],
  'stickers.perHourPerScene': [0, 20],
  'stickers.describeBatch': [0, 100],
  'limits.turnTimeoutMs': [60000, 3600000],
  'limits.turnIdleMs': [30000, 3600000],
  'limits.replyDelayMs': [0, 30000],
  'limits.jitterMs': [0, 10000],
  'limits.maxDelayMs': [0, 120000],
  'limits.batchMaxWaitMs': [0, 120000],
  'output.imageThreshold': [100, 5000],
  'output.maxReplyChars': [0, 4000],
  'output.fontSize': [14, 48],
  'output.width': [600, 2000],
  'archive.retentionDays': [0, 3650],
  'archive.mediaRetentionDays': [0, 3650],
  'backup.keep': [1, 365],
  'connection.botUin': [0, 99999999999],
  'safety.confirmTtlMs': [10_000, 600_000],
  'safety.toolGrantMinutes': [1, 120],
  'models.inputPrice': [0, 1000],
  'models.outputPrice': [0, 1000],
  'accounts.debugPort': [1024, 65535],
  'access.requestTtlMin': [1, 1440],
  'models.cachePrice': [0, 1000],
  'models.searchPrice': [0, 100],
  'models.fetchPrice': [0, 100],
  'output.replyCharsOwner': [0, 4000],
  'output.replyCharsGroup': [0, 4000],
  'models.offPeakDiscount': [0, 1],
  'appearance.backgroundDim': [0, 95],
  'appearance.backgroundBlur': [0, 24],
};

/**
 * Deep-merge a stored config over the defaults, keeping only known keys.
 *
 * @param {unknown} stored Parsed JSON from config.json, or anything else.
 * @returns {QQConfig} A complete, shape-safe configuration.
 */
export function mergeConfig(stored) {
  const base = defaults();
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return base;
  for (const section of Object.keys(base)) {
    const value = stored[section];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const key of Object.keys(base[section])) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) base[section][key] = value[key];
    }
  }
  return normalize(base);
}

/**
 * Clamp numbers, coerce enums to their defaults, and drop malformed values.
 *
 * @param {QQConfig} config A merged configuration.
 * @returns {QQConfig} The same object, corrected in place.
 */
export function normalize(config) {
  if (config.appearance === null || typeof config.appearance !== 'object' || Array.isArray(config.appearance)) {
    config.appearance = defaults().appearance;
  }
  for (const [path, [min, max]] of Object.entries(RANGES)) {
    const [section, key] = path.split('.');
    const value = Number(config[section][key]);
    // Prices and discounts keep their decimals; everything else is a whole number.
    const fractional = path === 'models.inputPrice' || path === 'models.outputPrice'
      || path === 'models.cachePrice' || path === 'models.offPeakDiscount'
      || path === 'models.searchPrice' || path === 'models.fetchPrice';
    config[section][key] = Number.isFinite(value) ? Math.min(max, Math.max(min, fractional ? value : Math.round(value))) : min;
  }

  const enums = {
    'access.strangerPolicy': ['ignore', 'notice', 'block'],
    'access.groupMode': ['whitelist', 'blacklist', 'all'],
    'limits.overLimit': ['refuse', 'silent', 'queue'],
    'output.style': ['light', 'dark', 'bubble'],
    'models.permissionPreset': ['', 'auto', 'workspace-write', 'danger-full-access'],
  };
  for (const [path, allowed] of Object.entries(enums)) {
    const [section, key] = path.split('.');
    if (!allowed.includes(config[section][key])) config[section][key] = allowed[0];
  }

  // The background ends up inside a CSS background-image, so only the three
  // shapes this plugin produces are allowed; anything else is discarded.
  if (typeof config.appearance.background !== 'string' || !BACKGROUND_PATTERN.test(config.appearance.background)) {
    config.appearance.background = '';
  }

  if (!Array.isArray(config.access.admins)) config.access.admins = [];
  config.access.admins = config.access.admins
    .filter(entry => entry !== null && typeof entry === 'object' && Number.isInteger(Number(entry.qq)))
    .map(entry => ({ qq: Number(entry.qq), name: String(entry.name ?? ''), addedAt: Number(entry.addedAt ?? 0) }));
  if (!Array.isArray(config.access.groups)) config.access.groups = [];
  config.access.groups = config.access.groups.map(Number).filter(Number.isInteger);
  if (!Array.isArray(config.access.blockedWords)) config.access.blockedWords = [];
  config.access.blockedWords = config.access.blockedWords.map(String).filter(Boolean);

  for (const key of ['httpUrl', 'wsUrl', 'eventPath', 'token', 'httpToken', 'snowlumaDir']) {
    if (typeof config.connection[key] !== 'string') config.connection[key] = defaults().connection[key];
  }
  if (typeof config.connection.autoStart !== 'boolean') config.connection.autoStart = true;
  if (typeof config.output.sendProcessingHint !== 'boolean') config.output.sendProcessingHint = false;
  if (typeof config.output.sendTypingStatus !== 'boolean') config.output.sendTypingStatus = true;
  if (typeof config.output.groupAtReply !== 'boolean') config.output.groupAtReply = true;
  for (const key of ['auto', 'includeMedia', 'includeCookies']) {
    if (typeof config.backup?.[key] !== 'boolean') config.backup[key] = defaults().backup[key];
  }
  for (const tier of ['owner', 'member', 'summarizer']) {
    const route = config.models[tier];
    if (route === null || typeof route !== 'object') config.models[tier] = { provider: '', model: '', effort: '' };
    else for (const key of ['provider', 'model', 'effort']) if (typeof route[key] !== 'string') route[key] = '';
  }
  return config;
}









