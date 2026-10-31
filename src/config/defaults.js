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
      /** whitelist | blacklist | all */
      groupMode: 'whitelist',
      /** @type {number[]} */
      groups: [],
      mentionOnly: true,
      /** @type {string[]} */
      blockedWords: [],
    },
    models: {
      owner: { provider: '', model: '', effort: '' },
      member: { provider: '', model: '', effort: '' },
      summarizer: { provider: '', model: '', effort: '' },
    },
    conversation: {
      /** Workspace directory for sessions created for a QQ scene; empty = DSH default. */
      cwd: '',
      /** owner private chats are intentionally unbounded; shown locked in the UI. */
      groupHistory: 99,
      groupCharCap: 6000,
  /** Rebuild a saved session bigger than this many KB at startup; 0 disables. */
  autoRebuildKb: 60,
  /** Tell the model not to repeat what other group members said. */
  groupPrivacy: true,
    },
    memory: {
      summaryLimit: 1000,
      personaLimit: 1000,
      autoNoteEvery: 8,
      impressionsEnabled: true,
      impressionEvery: 100,
      impressionMinChars: 800,
      impressionBudget: 600,
    },
    limits: {
      memberDaily: 20,
      groupDaily: 200,
      userPerMinute: 3,
      maxInputChars: 2000,
      concurrency: 2,
      queueMax: 10,
      turnTimeoutMs: 180000,
      replyDelayMs: 2000,
      jitterMs: 1500,
      maxDelayMs: 15000,
      /** refuse | silent | queue */
      overLimit: 'refuse',
    },
    output: {
      imageThreshold: 500,
  /** The model is asked to stay within this many characters; longer replies render as an image. 0 = no hint. */
  maxReplyChars: 250,
      /** light | dark | bubble */
      style: 'light',
      fontSize: 22,
      width: 1080,
      /** Send a "收到，正在处理…" chat message before the turn. Off by default. */
      sendProcessingHint: false,
      /** Show the QQ "typing" state instead: no bubble, same feedback. */
      sendTypingStatus: true,
    },
    archive: {
      enabled: true,
      media: false,
      retentionDays: 30,
  /** Media files age out faster than the rows that reference them. */
  mediaRetentionDays: 7,
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
      confirmTtlMs: 60000,
      audit: true,
    },
    ui: {
      /** Integrate with dsh-pet when it is installed: menu entry, bubbles, work status. */
      pet: true,
      /** dsh-pet instance id. */
      petId: 'main',
    },
  };
}

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
  'limits.replyDelayMs': [0, 30000],
  'limits.jitterMs': [0, 10000],
  'limits.maxDelayMs': [0, 120000],
  'output.imageThreshold': [100, 5000],
  'output.maxReplyChars': [0, 4000],
  'output.fontSize': [14, 48],
  'output.width': [600, 2000],
  'archive.retentionDays': [0, 3650],
  'archive.mediaRetentionDays': [0, 3650],
  'connection.botUin': [0, 99999999999],
  'safety.confirmTtlMs': [10000, 600000],
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
  for (const [path, [min, max]] of Object.entries(RANGES)) {
    const [section, key] = path.split('.');
    const value = Number(config[section][key]);
    config[section][key] = Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
  }

  const enums = {
    'access.strangerPolicy': ['ignore', 'notice', 'block'],
    'access.groupMode': ['whitelist', 'blacklist', 'all'],
    'limits.overLimit': ['refuse', 'silent', 'queue'],
    'output.style': ['light', 'dark', 'bubble'],
  };
  for (const [path, allowed] of Object.entries(enums)) {
    const [section, key] = path.split('.');
    if (!allowed.includes(config[section][key])) config[section][key] = allowed[0];
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
  if (typeof config.ui.pet !== 'boolean') config.ui.pet = true;
  if (typeof config.ui.petId !== 'string' || config.ui.petId === '') config.ui.petId = 'main';
  for (const tier of ['owner', 'member', 'summarizer']) {
    const route = config.models[tier];
    if (route === null || typeof route !== 'object') config.models[tier] = { provider: '', model: '', effort: '' };
    else for (const key of ['provider', 'model', 'effort']) if (typeof route[key] !== 'string') route[key] = '';
  }
  return config;
}









