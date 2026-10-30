/**
 * Per-sender and per-group quotas.
 *
 * The thresholds live in the configuration; this module only counts and answers.
 * Counters are daily (Beijing calendar day) and in-memory: a restart resets them,
 * which is acceptable for a single-user bridge and keeps the hot path sync.
 */

/** Milliseconds in one minute, the rate window. */
const MINUTE_MS = 60_000;

/**
 * Beijing calendar day key.
 *
 * @param {number} now Epoch milliseconds.
 * @returns {string} `YYYY-MM-DD` in Asia/Shanghai.
 */
export function dayKey(now = Date.now()) {
  const shifted = new Date(now + 8 * 3600 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Daily and per-minute counters for non-admin senders. */
export class Quota {
  constructor() {
    /** @type {Map<string, number>} */
    this.daily = new Map();
    /** @type {Map<number, number[]>} */
    this.minute = new Map();
    this.day = dayKey();
  }

  /** Drop yesterday's counters. */
  #roll(now) {
    const key = dayKey(now);
    if (key === this.day) return;
    this.day = key;
    this.daily.clear();
    this.minute.clear();
  }

  /**
   * Decide whether this message may be answered.
   *
   * @param {{ senderId: number, scene: string }} message Normalized message.
   * @param {{ memberDaily: number, groupDaily: number, userPerMinute: number }} limits Configured limits.
   * @param {string} tier Resolved tier; owners bypass quotas.
   * @param {number} [now] Epoch milliseconds.
   * @returns {{ allowed: boolean, reason?: 'member-daily' | 'group-daily' | 'rate' }} The decision.
   */
  check(message, limits, tier, now = Date.now()) {
    if (tier === 'owner') return { allowed: true };
    this.#roll(now);

    const member = this.daily.get(`m:${this.day}:${message.senderId}`) ?? 0;
    if (limits.memberDaily > 0 && member >= limits.memberDaily) return { allowed: false, reason: 'member-daily' };

    if (message.scene.startsWith('group:')) {
      const group = this.daily.get(`g:${this.day}:${message.scene}`) ?? 0;
      if (limits.groupDaily > 0 && group >= limits.groupDaily) return { allowed: false, reason: 'group-daily' };
    }

    const recent = (this.minute.get(message.senderId) ?? []).filter(at => now - at < MINUTE_MS);
    if (recent.length >= limits.userPerMinute) return { allowed: false, reason: 'rate' };

    return { allowed: true };
  }

  /**
   * Count one answered message.
   *
   * @param {{ senderId: number, scene: string }} message Normalized message.
   * @param {string} tier Resolved tier.
   * @param {number} [now] Epoch milliseconds.
   */
  record(message, tier, now = Date.now()) {
    if (tier === 'owner') return;
    this.#roll(now);
    const memberKey = `m:${this.day}:${message.senderId}`;
    this.daily.set(memberKey, (this.daily.get(memberKey) ?? 0) + 1);
    if (message.scene.startsWith('group:')) {
      const groupKey = `g:${this.day}:${message.scene}`;
      this.daily.set(groupKey, (this.daily.get(groupKey) ?? 0) + 1);
    }
    const recent = (this.minute.get(message.senderId) ?? []).filter(at => now - at < MINUTE_MS);
    recent.push(now);
    this.minute.set(message.senderId, recent);
  }

  /** @returns {{ day: string, senders: number, scenes: number }} A small snapshot. */
  snapshot() {
    return { day: this.day, senders: this.minute.size, scenes: this.daily.size };
  }
}

/** Plain counting semaphore with a bounded wait queue. */
export class Semaphore {
  /**
   * @param {number} limit Maximum concurrent holders.
   */
  constructor(limit) {
    this.limit = Math.max(1, Math.floor(limit));
    this.active = 0;
    /** @type {Array<() => void>} */
    this.waiters = [];
  }

  /** @returns {number} How many callers are waiting. */
  get pending() {
    return this.waiters.length;
  }

  /**
   * Take a slot.
   *
   * @returns {Promise<() => void>} Resolves with the release function.
   */
  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.#release());
    }
    return new Promise(resolve => {
      this.waiters.push(() => resolve(() => this.#release()));
    });
  }

  /** Hand the slot to the next waiter, or free it. */
  #release() {
    const next = this.waiters.shift();
    if (next !== undefined) next();
    else this.active = Math.max(0, this.active - 1);
  }
}
