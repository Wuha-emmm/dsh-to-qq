/**
 * Per-person memory cards.
 *
 * A card belongs to one QQ number and is shared across private chats and every
 * group: the model reads it before answering, and only the person themselves can
 * change their persona or clear the card. The notes are written by the model
 * through a tool, so there is no second summarizer call to pay for.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Default caps, mirrored from the configuration defaults. */
const DEFAULT_NOTE_LIMIT = 1000;
const DEFAULT_PERSONA_LIMIT = 1000;
const MAX_NOTE_CHARS = 240;

/**
 * @typedef {object} MemoryNote
 * @property {number} at Unix milliseconds when the note was written.
 * @property {string} text The note itself.
 */

/**
 * @typedef {object} MemoryCard
 * @property {MemoryNote[]} notes Newest last.
 * @property {{ text: string, at: number } | null} persona User-authored style instruction.
 */

/** Durable store for every card, kept beside the other plugin state. */
import { filterNotes, sanitizeNote, compileWords } from './sensitive.js';

export class MemoryStore {
  /**
   * @param {string} file Absolute path to memory.json.
   */
  constructor(file) {
    this.file = file;
    /** Privacy policy: enabled flag plus owner-supplied extra words. */
    this.privacy = { enabled: true, words: [] };
    /** @type {Map<string, MemoryCard>} */
    this.cards = new Map();
    /** Run statistics, kept so a restart does not reset the panel. */
    this.meta = { impressions: {} };
    this.loaded = false;
  }

  /** Read the file, tolerating absence and corruption. */
  async load() {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [qq, card] of Object.entries(parsed)) {
          if (qq === 'meta') {
            this.meta = { impressions: { ...(card?.impressions ?? {}) } };
            continue;
          }
          this.cards.set(qq, this.#sanitizeCard(normalizeCard(card)));
        }
        if (this.cleaned === true) await this.save();
      }
    } catch {
      // A missing or unreadable file simply starts empty.
    }
    this.loaded = true;
  }

  /**
   * Apply the privacy policy to one card's notes.
   *
   * @param {MemoryCard} card Card to clean in place.
   * @returns {MemoryCard} The same card.
   */
  #sanitizeCard(card) {
    if (this.privacy.enabled !== true) return card;
    const filtered = this.#filterNotes(card.notes);
    if (filtered.notes.length !== card.notes.length) this.cleaned = true;
    card.notes = filtered.notes;
    return card;
  }

  /**
   * Drop or soften notes according to the policy.
   *
   * @param {Array<{ at: number, text: string }>} notes Raw notes.
   * @returns {{ notes: Array<{ at: number, text: string }> }} Filtered notes.
   */
  #filterNotes(notes) {
    if (this.privacy.enabled !== true) return { notes };
    const extra = compileWords(this.privacy.words);
    const result = filterNotes(notes, extra);
    if (result.dropped > 0) this.dropped = (this.dropped ?? 0) + result.dropped;
    return { notes: result.notes };
  }

  /**
   * Install the privacy policy from configuration.
   *
   * @param {{ enabled?: boolean, words?: string[] }} [policy] Policy patch.
   * @returns {void}
   */
  setPrivacy(policy = {}) {
    this.privacy = {
      enabled: policy.enabled !== false,
      words: Array.isArray(policy.words) ? policy.words : [],
    };
  }

  /**
   * Read one card, creating an empty one on first use.
   *
   * @param {number | string} qq Owner QQ number.
   * @returns {MemoryCard} The card.
   */
  get(qq) {
    const key = String(qq);
    const existing = this.cards.get(key);
    if (existing !== undefined) return existing;
    /** @type {MemoryCard} */
    const fresh = { notes: [], persona: null, impressionCursor: 0, name: '' };
    this.cards.set(key, fresh);
    return fresh;
  }

  /**
   * Replace the impression list of one card.
   *
   * @param {number | string} qq Owner QQ number.
   * @param {Array<{ at: number, text: string }>} notes Replacement notes.
   * @returns {Promise<void>} Resolves after the write.
   */
  async setNotes(qq, notes) {
    const card = this.get(qq);
    const filtered = this.#filterNotes(Array.isArray(notes) ? notes : []);
    card.notes = filtered.notes;
    await this.save();
  }

  /**
   * Remember the display name last seen for this person.
   *
   * The name only lives in the QQ event, so without this the card could not be
   * titled after a restart.
   *
   * @param {number | string} qq Owner QQ number.
   * @param {string} name Display name from the event.
   * @returns {Promise<boolean>} True when the stored name changed.
   */
  async setName(qq, name) {
    const clean = String(name ?? '').trim().slice(0, 40);
    if (clean === '') return false;
    const card = this.get(qq);
    if (card.name === clean) return false;
    card.name = clean;
    await this.save();
    return true;
  }

  /**
   * Remember how far the impression summarizer has read.
   *
   * @param {number | string} qq Owner QQ number.
   * @param {number} at Unix seconds of the last message consumed.
   * @returns {Promise<void>} Resolves after the write.
   */
  async setImpressionCursor(qq, at) {
    const card = this.get(qq);
    card.impressionCursor = Number(at) || 0;
    await this.save();
  }

  /**
   * Append one note, trimming the oldest notes past the character budget.
   *
   * @param {number | string} qq Owner QQ number.
   * @param {string} text Note body.
   * @param {number} [limit] Total characters allowed for notes.
   * @returns {Promise<MemoryCard>} The updated card.
   */
  async addNote(qq, text, limit = DEFAULT_NOTE_LIMIT) {
    const card = this.get(qq);
    const raw = String(text ?? '').trim().slice(0, MAX_NOTE_CHARS);
    if (raw === '') return card;
    // Credentials, remote-control habits and captures never enter a card.
    const safe = this.privacy.enabled === true
      ? sanitizeNote(raw, compileWords(this.privacy.words))
      : { dropped: false, text: raw };
    if (safe.dropped) {
      this.dropped = (this.dropped ?? 0) + 1;
      return card;
    }
    card.notes.push({ at: Date.now(), text: safe.text });
    let total = card.notes.reduce((sum, note) => sum + note.text.length, 0);
    while (total > limit && card.notes.length > 1) {
      const removed = card.notes.shift();
      total -= removed?.text.length ?? 0;
    }
    await this.save();
    return card;
  }

  /**
   * Replace the owner's persona.
   *
   * @param {number | string} qq Owner QQ number.
   * @param {string} text Persona text.
   * @param {number} [limit] Maximum characters.
   * @returns {Promise<MemoryCard>} The updated card.
   */
  async setPersona(qq, text, limit = DEFAULT_PERSONA_LIMIT) {
    const card = this.get(qq);
    const trimmed = String(text ?? '').trim().slice(0, limit);
    card.persona = trimmed === '' ? null : { text: trimmed, at: Date.now() };
    await this.save();
    return card;
  }

  /**
   * Forget everything about one person.
   *
   * @param {number | string} qq Owner QQ number.
   * @returns {Promise<void>} Resolves after the write.
   */
  async clear(qq) {
    this.cards.delete(String(qq));
    await this.save();
  }

  /**
   * Read the persisted impression run statistics.
   *
   * @returns {{ lastAt?: number, filled?: number, scanned?: number, failed?: number, retried?: number }} Stored counters.
   */
  impressionStats() {
    return { ...this.meta.impressions };
  }

  /**
   * Persist impression run statistics.
   *
   * @param {Record<string, number>} stats Counters to store.
   * @returns {Promise<void>} Resolves after the file is written.
   */
  async saveImpressionStats(stats) {
    this.meta.impressions = { ...stats };
    await this.save();
  }

  /**
   * Read the per-person cooldown map (QQ -> last run timestamp).
   *
   * @returns {Record<string, number>} Stored timestamps.
   */
  impressionRuns() {
    const runs = this.meta.impressionRuns;
    return runs !== null && typeof runs === 'object' && !Array.isArray(runs) ? { ...runs } : {};
  }

  /**
   * Persist the per-person cooldown map.
   *
   * @param {Map<number, number>} runs QQ -> timestamp.
   * @returns {Promise<void>} Resolves after the file is written.
   */
  async saveImpressionRuns(runs) {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const kept = {};
    for (const [qq, at] of runs) {
      if (Number(at) >= cutoff) kept[String(qq)] = Number(at);
    }
    this.meta.impressionRuns = kept;
    await this.save();
  }

  /** @returns {Record<string, any>} A plain snapshot. */
  toJSON() {
    return { ...Object.fromEntries(this.cards), meta: this.meta };
  }

  /** Persist every card atomically. */
  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(temporary, `${JSON.stringify(this.toJSON(), null, 2)}\n`, 'utf8');
    // Windows occasionally refuses the rename while a scanner holds the handle.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, this.file);
        return;
      } catch (error) {
        if (attempt >= 2) {
          await rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
      }
    }
  }
}

/**
 * Coerce one stored card into the expected shape.
 *
 * @param {any} value Raw value.
 * @returns {MemoryCard} A safe card.
 */
function normalizeCard(value) {
  const notes = Array.isArray(value?.notes)
    ? value.notes
      .filter(note => note !== null && typeof note === 'object' && typeof note.text === 'string')
      .map(note => ({ at: Number(note.at) || 0, text: note.text }))
    : [];
  const persona = value?.persona !== null && typeof value?.persona === 'object' && typeof value.persona.text === 'string'
    ? { text: value.persona.text, at: Number(value.persona.at) || 0 }
    : null;
  return { notes, persona, name: typeof value?.name === 'string' ? value.name.slice(0, 40) : '' };
}

/**
 * Render the card as the block injected before a turn.
 *
 * @param {object} request Render request.
 * @param {MemoryCard} request.card The owner's card.
 * @param {string} request.name Display name of the owner.
 * @param {number} request.qq Owner QQ number.
 * @returns {string} The injection block, or an empty string when the card is empty.
 */
export function renderCard(request) {
  const { card, name, qq } = request;
  const hasNotes = card.notes.length > 0;
  if (!hasNotes && card.persona === null) return '';
  const lines = [`【记忆卡 · ${name}(${qq})】`];
  // Compaction can leave an older copy of this card inside the summary. The card
  // is re-sent after compaction, so say which copy wins instead of letting the
  // model average the two.
  lines.push('（本卡为最新版本；上文若出现旧卡或摘要里的旧卡，一律以本卡为准）');
  if (card.persona !== null) lines.push(`人设（对方对我的要求，照着做）：${card.persona.text}`);
  if (hasNotes) {
    const safe = filterNotes(card.notes);
    lines.push('我对这个人的印象（从聊天里记下的）：');
    for (const note of safe.notes) lines.push(`- ${note.text}`);
  }
  lines.push('（人设 = 对方要求你怎么说话，用 memory_persona_set 改；笔记 = 你观察到的事实，用 memory_note 记。别把说话规则写进笔记。）');
  return lines.join('\n');
}




