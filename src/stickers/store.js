/**
 * Sticker library.
 *
 * QQ's "custom faces" (收藏表情) are the account's own sticker set. Each has an
 * id, an md5, a preview URL and — sometimes — a description. The store keeps
 * them on disk, downloads one preview per sticker, and remembers the fields the
 * owner edited by hand (category, note, code) so a bad model description never
 * becomes permanent.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** How many stickers one sync asks for. */
const FETCH_COUNT = 200;

/**
 * @typedef {object} Sticker
 * @property {string} id SnowLuma emoji id.
 * @property {string} md5 32-hex content hash.
 * @property {string} url Preview image URL from QQ.
 * @property {string} file Local preview file name inside the sticker directory.
 * @property {string} code Short handle shown in the catalog and editable.
 * @property {string} desc Note/description; '' when unread.
 * @property {string} category Free-form category, '' when unset.
 * @property {number} readAt Epoch ms when it was recognized; 0 = unread.
 * @property {boolean} manual True once the owner edited it by hand.
 * @property {number} uses How often the bot sent it.
 * @property {number} addedAt First time seen (epoch ms).
 */

export class StickerStore {
  /**
   * @param {string} file Absolute path to stickers.json.
   * @param {string} [directory] Where preview images live.
   */
  constructor(file, directory = '') {
    this.file = file;
    this.directory = directory;
    /** @type {Map<string, Sticker>} */
    this.items = new Map();
    /** Scene -> epoch ms when stickers were turned off there. */
    this.muted = new Map();
    this.loaded = false;
    this.syncedAt = 0;
  }

  /** Read the file, tolerating absence and corruption. */
  async load() {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.syncedAt = Number(parsed?.syncedAt) || 0;
      for (const item of Array.isArray(parsed?.items) ? parsed.items : []) {
        const sticker = normalize(item);
        if (sticker !== undefined) this.items.set(sticker.md5, sticker);
      }
      for (const [scene, at] of Object.entries(parsed?.muted ?? {})) {
        this.muted.set(scene, Number(at) || Date.now());
      }
    } catch {
      // Missing or unreadable simply starts empty.
    }
    this.loaded = true;
  }

  /** @returns {Sticker[]} Every sticker, newest first. */
  all() {
    return [...this.items.values()].sort((left, right) => right.addedAt - left.addedAt);
  }

  /** @returns {number} How many are known. */
  get size() {
    return this.items.size;
  }

  /** @returns {number} How many were recognized (or edited) already. */
  get readCount() {
    return [...this.items.values()].filter(sticker => sticker.readAt > 0).length;
  }

  /** @returns {Sticker[]} Stickers still waiting for a description. */
  unread() {
    return [...this.items.values()].filter(sticker => sticker.readAt === 0);
  }

  /**
   * Look one up by code, md5, full id, or a unique md5 prefix.
   *
   * @param {string} key Code / md5 / id / prefix.
   * @returns {Sticker | undefined} The sticker.
   */
  find(key) {
    const raw = String(key ?? '').trim();
    if (raw === '') return undefined;
    for (const sticker of this.items.values()) {
      if (sticker.code === raw) return sticker;
    }
    const byHash = this.items.get(raw.toLowerCase());
    if (byHash !== undefined) return byHash;
    for (const sticker of this.items.values()) {
      if (sticker.id === raw) return sticker;
    }
    const matches = [...this.items.values()].filter(sticker => sticker.md5.startsWith(raw.toLowerCase()));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Merge the transport's list into the store.
   *
   * @param {ReadonlyArray<{ emoji_id?: string, md5?: string, url?: string, desc?: string }>} list Fetched details.
   * @returns {{ added: number, updated: number, total: number }} What changed.
   */
  merge(list) {
    const now = Date.now();
    let added = 0;
    let updated = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      const md5 = String(raw?.md5 ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(md5)) continue;
      const desc = String(raw?.desc ?? '').trim();
      const url = String(raw?.url ?? '').trim();
      const id = String(raw?.emoji_id ?? '').trim();
      const existing = this.items.get(md5);
      if (existing === undefined) {
        this.items.set(md5, {
          id,
          md5,
          url,
          file: '',
          code: md5.slice(0, 6),
          desc,
          category: '',
          // QQ's own description counts as read: it is already usable text.
          readAt: desc === '' ? 0 : now,
          manual: false,
          uses: 0,
          addedAt: now,
        });
        added += 1;
        continue;
      }
      // A later sync only fills gaps; it never erases a learned description.
      if (desc !== '' && existing.desc === '' && existing.manual === false) {
        existing.desc = desc;
        existing.readAt = existing.readAt === 0 ? now : existing.readAt;
        updated += 1;
      }
      if (url !== '' && existing.url === '') { existing.url = url; updated += 1; }
      if (id !== '' && existing.id === '') { existing.id = id; updated += 1; }
    }
    this.syncedAt = now;
    return { added, updated, total: this.items.size };
  }

  /**
   * Store the generated description and mark the sticker read.
   *
   * @param {string} md5 Sticker hash.
   * @param {string} desc Description text.
   * @returns {boolean} True when it was stored.
   */
  /**
   * Store a generated description.
   *
   * Manual edits normally win, because a bad model guess must never erase what
   * the owner typed. An explicit single-sticker re-analysis passes `force`, which
   * overwrites the old text and hands the sticker back to the model.
   *
   * @param {string} md5 Sticker hash.
   * @param {string | { desc?: string, category?: string }} desc Text or analysis.
   * @param {string} [category] Mood, when `desc` is a string.
   * @param {{ force?: boolean }} [options] Override a manual edit.
   * @returns {boolean} True when it was stored.
   */
  setDescription(md5, desc, category, options = {}) {
    const sticker = this.items.get(String(md5).toLowerCase());
    const parsed = desc !== null && typeof desc === 'object' ? desc : { desc, category };
    const text = String(parsed?.desc ?? '').trim().slice(0, 60);
    const mood = String(parsed?.category ?? '').trim().slice(0, 12);
    if (sticker === undefined) return false;
    if (sticker.manual && options.force !== true) {
      // Never overwrite what the owner typed; only mark it read.
      sticker.readAt = sticker.readAt === 0 ? Date.now() : sticker.readAt;
      return true;
    }
    if (text === '') return false;
    sticker.desc = text;
    if (mood !== '') sticker.category = mood;
    // A forced re-analysis replaces the manual edit, so later runs behave like
    // any other model-described sticker again.
    if (options.force === true) sticker.manual = false;
    sticker.readAt = Date.now();
    return true;
  }

  /**
   * Apply manual edits from the settings page.
   *
   * @param {string} md5 Sticker hash.
   * @param {{ code?: string, desc?: string, category?: string }} patch Fields to set.
   * @returns {Sticker | undefined} The updated sticker.
   */
  update(md5, patch) {
    const sticker = this.items.get(String(md5).toLowerCase());
    if (sticker === undefined) return undefined;
    if (typeof patch?.code === 'string' && patch.code.trim() !== '') {
      const code = patch.code.trim().slice(0, 12);
      // Codes identify stickers in the model prompt, so they must stay unique.
      const taken = [...this.items.values()].some(item => item.md5 !== sticker.md5 && item.code === code);
      if (!taken) sticker.code = code;
    }
    if (typeof patch?.desc === 'string') sticker.desc = patch.desc.trim().slice(0, 60);
    if (typeof patch?.category === 'string') sticker.category = patch.category.trim().slice(0, 12);
    sticker.manual = true;
    sticker.readAt = Date.now();
    return sticker;
  }

  /**
   * Remember the local preview file for one sticker.
   *
   * @param {string} md5 Sticker hash.
   * @param {string} file File name inside the sticker directory.
   * @returns {void}
   */
  setFile(md5, file) {
    const sticker = this.items.get(String(md5).toLowerCase());
    if (sticker !== undefined) sticker.file = String(file);
  }

  /**
   * Remember that one sticker was sent.
   *
   * @param {string} md5 Sticker hash.
   * @returns {void}
   */
  recordUse(md5) {
    const sticker = this.items.get(String(md5).toLowerCase());
    if (sticker !== undefined) sticker.uses += 1;
  }

  /**
   * Whether stickers are turned off for one scene.
   *
   * @param {string} scene Scene key.
   * @returns {boolean} True when muted.
   */
  isMuted(scene) {
    return this.muted.has(scene);
  }

  /**
   * Turn stickers off for one scene.
   *
   * @param {string} scene Scene key.
   * @returns {void}
   */
  mute(scene) {
    this.muted.set(scene, Date.now());
  }

  /**
   * Turn stickers back on for one scene.
   *
   * @param {string} scene Scene key.
   * @returns {void}
   */
  unmute(scene) {
    this.muted.delete(scene);
  }

  /**
   * Ask the transport for the account's sticker list.
   *
   * @param {{ call: (action: string, params: object, options?: object) => Promise<any> }} client OneBot client.
   * @returns {Promise<{ added: number, updated: number, total: number }>} Merge result.
   */
  async sync(client) {
    const result = await client.call('fetch_custom_face_detail', { count: FETCH_COUNT }, { timeoutMs: 30_000 });
    const list = Array.isArray(result?.data) ? result.data : (Array.isArray(result) ? result : []);
    return this.merge(list);
  }

  /** Persist the library atomically. */
  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const body = JSON.stringify({
      syncedAt: this.syncedAt,
      items: this.all(),
      muted: Object.fromEntries(this.muted),
    }, null, 2);
    const temporary = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(temporary, `${body}\n`, 'utf8');
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
 * Coerce one stored entry into a sticker.
 *
 * @param {any} value Raw value.
 * @returns {Sticker | undefined} A safe sticker, or undefined when unusable.
 */
function normalize(value) {
  const md5 = String(value?.md5 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(md5)) return undefined;
  return {
    id: String(value?.id ?? ''),
    md5,
    url: String(value?.url ?? ''),
    file: String(value?.file ?? ''),
    code: String(value?.code ?? md5.slice(0, 6)).slice(0, 12),
    desc: String(value?.desc ?? '').slice(0, 60),
    category: String(value?.category ?? '').slice(0, 12),
    // Older files stored a description without a read timestamp; treat a
    // non-empty description as already read so the counter is truthful.
    readAt: Number(value?.readAt) || (String(value?.desc ?? '').trim() === '' ? 0 : (Number(value?.addedAt) || Date.now())),
    manual: value?.manual === true,
    uses: Number(value?.uses) || 0,
    addedAt: Number(value?.addedAt) || 0,
  };
}


