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
  return `${entry?.time ?? 0}|${entry?.senderId ?? 0}|${entry?.text ?? ''}`;
}

/** Tracks which fixed context blocks a session already received. */
export class InjectionTracker {
  /**
   * @param {{ seenLimit?: number }} [options] Wiring.
   */
  constructor(options = {}) {
    this.seenLimit = Math.max(50, Number(options.seenLimit) || 400);
    this.cardHash = '';
    this.stickerHash = '';
    this.rulesHash = '';
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
   * @param {'card' | 'stickers' | 'rules'} slot Which fixed block.
   * @param {string} block Block text; '' means the block is empty.
   * @returns {string} The block to send, or '' when the session already has it.
   */
  fixed(slot, block) {
    const text = String(block ?? '');
    if (text === '') return '';
    const hash = textHash(text);
    if (this[`${slot}Hash`] === hash) {
      this.skipped += text.length;
      return '';
    }
    this[`${slot}Hash`] = hash;
    this.injected += text.length;
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
    for (const entry of list) this.seen.add(entrySignature(entry));
    this.#trimSeen();
    return fresh;
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
