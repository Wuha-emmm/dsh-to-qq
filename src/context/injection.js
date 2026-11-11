/**
 * Per-session context injection.
 *
 * Every turn used to re-send the memory card, the sticker catalog and the whole
 * group window, and each copy stayed in the session forever. This tracker keeps
 * one session's worth of state so a block is sent when it appears or changes,
 * and the group window only contributes the messages the model has not seen.
 */

/**
 * Stable, cheap hash for a context block.
 *
 * FNV-1a is enough here: the input is our own generated text, and a collision
 * only means one block is skipped once.
 *
 * @param {string} text Block text.
 * @returns {string} Hex hash.
 */
export function textHash(text) {
  const body = String(text ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** Signature of one buffered message, used to detect what was already sent. */
export function entrySignature(entry) {
  // QQ gives every message an id, and it is unique even when the same person
  // sends the same text twice in the same second. Only fall back to the content
  // signature when no id survived (backfill or a synthetic entry).
  const id = entry?.messageId;
  if (id !== undefined && id !== null && Number(id) !== 0) return `id:${id}`;
  return `${entry?.time ?? 0}|${entry?.senderId ?? 0}|${entry?.text ?? ''}`;
}

/** Tracks which fixed context blocks a session already received. */
export class InjectionTracker {
  /**
   * @param {{ seenLimit?: number, store?: { save: (state: object) => void } }} [options] Wiring.
   */
  constructor(options = {}) {
    this.seenLimit = Math.max(50, Number(options.seenLimit) || 400);
    // Persisting the ledger across restarts is what keeps the first turn of a
    // new process from re-sending a window the session already has.
    this.store = options.store;
    /**
     * Card hashes, one per sender.
     *
     * A group scene carries a different card for every speaker, so a single
     * slot would flip-flop: A, B, A, B… and re-send a whole card on every turn.
     * Keyed by sender id, each person's card is sent once, and again only when
     * that person's card changes.
     *
     * @type {Map<string | number, string>}
     */
    this.cardHash = new Map();
    /**
     * Scope notes, one per speaker.
     *
     * Everyone in a group shares one session, so the transcript ends up holding
     * other people's cards. A note naming the current asker goes out the first time
     * that person speaks, and again only when its text changes — one line per
     * speaker, never one line per turn.
     *
     * @type {Map<string | number, string>}
     */
    this.scopeHash = new Map();
    this.stickerHash = '';
    this.rulesHash = '';
    /** @type {string} Hash of the group-default-persona block. */
    this.groupPersonaHash = '';
    /** @type {Set<string>} Message signatures already inside the session. */
    this.seen = new Set();
    /** Characters that were not re-sent, for reporting. */
    this.skipped = 0;
    /** Characters actually injected this turn. */
    this.injected = 0;
  }

  /**
   * Send a block the first time, or when its text changes.
   *
   * A slot whose store is a `Map` keeps one hash per key, so blocks that differ
   * per sender (the memory card) do not overwrite each other. Slots with a
   * plain string store behave as before: one hash for the whole scene.
   *
   * @param {'card' | 'stickers' | 'rules' | 'length' | 'groupPersona'} slot Which fixed block.
   * @param {string} block Block text; '' means the block is empty.
   * @param {string | number} [key] Per-entity key, used by map-backed slots.
   * @returns {string} The block to send, or '' when the session already has it.
   */
  fixed(slot, block, key = '') {
    const text = String(block ?? '');
    if (text === '') return '';
    const hash = textHash(text);
    const store = this[`${slot}Hash`];
    if (store instanceof Map) {
      if (store.get(key) === hash) {
        this.skipped += text.length;
        return '';
      }
      store.set(key, hash);
      this.injected += text.length;
      this.#persist();
      return text;
    }
    if (store === hash) {
      this.skipped += text.length;
      return '';
    }
    this[`${slot}Hash`] = hash;
    this.injected += text.length;
    this.#persist();
    return text;
  }

  /**
   * Messages from the window that the session has not seen yet.
   *
   * @param {Array<{ time?: number, senderId?: number, text?: string }>} entries Current window, oldest first.
   * @returns {Array<object>} The unseen entries, oldest first.
   */
  delta(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const fresh = list.filter(entry => !this.seen.has(entrySignature(entry)));
    if (fresh.length > 0) {
      for (const entry of list) this.seen.add(entrySignature(entry));
      this.#trimSeen();
      this.#persist();
    }
    return fresh;
  }

  /**
   * Restore a ledger saved by an earlier process.
   *
   * Only useful when the session binding is the same one: a new session has
   * seen nothing, so its blocks must go out again.
   *
   * @param {{ seen?: string[], blocks?: { slot: string, key: string, hash: string }[] }} state Saved state.
   * @returns {void}
   */
  hydrate(state) {
    for (const signature of state?.seen ?? []) this.seen.add(String(signature));
    for (const block of state?.blocks ?? []) {
      const store = this[`${block.slot}Hash`];
      if (store instanceof Map) store.set(block.key, block.hash);
      else if (String(block.key ?? '') === '') this[`${block.slot}Hash`] = block.hash;
    }
    this.#trimSeen();
  }

  /**
   * Snapshot the ledger for persistence.
   *
   * @param {string} [sessionId] Session the ledger belongs to.
   * @returns {{ sessionId: string, seen: string[], blocks: { slot: string, key: string, hash: string }[] }} Snapshot.
   */
  snapshot(sessionId = this.sessionId) {
    /** @type {{ slot: string, key: string, hash: string }[]} */
    const blocks = [];
    for (const slot of ['card', 'scope']) {
      const store = this[`${slot}Hash`];
      if (store instanceof Map) {
        for (const [key, hash] of store) blocks.push({ slot, key: String(key), hash });
      }
    }
    for (const slot of ['rules', 'stickers', 'length', 'scopeFix', 'groupPersona']) {
      const hash = this[`${slot}Hash`];
      if (typeof hash === 'string' && hash !== '') blocks.push({ slot, key: '', hash });
    }
    return { sessionId: String(sessionId ?? ''), seen: [...this.seen], blocks };
  }

  /** Write the ledger through to the store, when one is wired. */
  #persist() {
    if (typeof this.store?.save !== 'function') return;
    try {
      this.store.save(this.snapshot());
    } catch {
      // Persistence is an optimisation: never fail a turn over it.
    }
  }

  /** Drop the oldest signatures so a long session cannot grow without bound. */
  #trimSeen() {
    if (this.seen.size <= this.seenLimit) return;
    const excess = this.seen.size - this.seenLimit;
    let removed = 0;
    for (const signature of this.seen) {
      this.seen.delete(signature);
      removed += 1;
      if (removed >= excess) break;
    }
  }

  /**
   * Account for text that is always sent (the message, quotes, notes).
   *
   * @param {number} chars Characters actually injected outside `fixed`.
   * @returns {void}
   */
  note(chars) {
    this.injected += Math.max(0, Number(chars) || 0);
  }

  /** @returns {{ injected: number, skipped: number }} Totals for this turn. */
  get stats() {
    return { injected: this.injected, skipped: this.skipped };
  }
}
