/**
 * Display names for QQ scenes.
 *
 * The conversation list must show a group name or a person's nickname instead
 * of a bare QQ number. The transport can be asked for either name, but that is
 * a round trip and fails while it reconnects, so every resolved name is cached
 * both in memory and in `scene-names.json`. A stale name still beats a number.
 *
 * Names are untrusted input: group names are chosen by strangers, and a remark
 * can contain control characters. `cleanDisplayName` keeps one short, safe line.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Trust a cached name this long before refreshing it from the transport. */
const NAME_TTL_MS = 6 * 60 * 60 * 1000;
/** Failed lookups back off this long, so an offline transport is not hammered. */
const RETRY_MS = 60_000;
/** QQ nicknames are short; anything longer is noise or an attack. */
const MAX_NAME_CHARS = 40;
/** Scene keys are the only keys this store accepts. */
const SCENE_PATTERN = /^(group|dm):([1-9]\d{3,11})$/;

/**
 * Parse a scene key.
 *
 * @param {unknown} scene Scene key such as `group:20001` or `dm:10001`.
 * @returns {{ kind: 'group' | 'dm', id: number } | undefined} Parts, or undefined.
 */
export function parseSceneKey(scene) {
  const match = SCENE_PATTERN.exec(String(scene ?? ''));
  if (match === null) return undefined;
  const kind = match[1];
  if (kind !== 'group' && kind !== 'dm') return undefined;
  return { kind, id: Number(match[2]) };
}

/**
 * Make a transport-provided name safe to render on one line.
 *
 * Control characters, bidi overrides, and zero-width characters are replaced
 * with spaces; runs of whitespace collapse, and the result is capped so one
 * absurd nickname cannot push the rest of the list out of view.
 *
 * @param {unknown} value Raw name.
 * @returns {string} Trimmed, single-line, capped name.
 */
export function cleanDisplayName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_CHARS);
}

/** Durable cache of scene key -> display name. */
export class SceneNames {
  /**
   * @param {string} file Absolute path to `scene-names.json`.
   * @param {{ log?: (line: string) => void }} [options] Diagnostic sink.
   */
  constructor(file, options = {}) {
    this.file = file;
    this.log = options.log ?? (() => {});
    this.names = new Map();
    this.at = new Map();
    this.pending = new Map();
    this.retryAt = new Map();
    this.loading = undefined;
    this.loaded = false;
    this.dirty = false;
    this.saving = Promise.resolve();
  }

  /**
   * Read the on-disk cache once.
   *
   * @returns {Promise<SceneNames>} This store, loaded.
   */
  load() {
    this.loading ??= this.#load();
    return this.loading;
  }

  async #load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      const rows = parsed?.names ?? {};
      if (rows !== null && typeof rows === 'object' && !Array.isArray(rows)) {
        for (const [scene, entry] of Object.entries(rows)) {
          if (parseSceneKey(scene) === undefined) continue;
          // A lookup that finished while the file was being read is newer.
          if (this.names.has(scene)) continue;
          const raw = typeof entry === 'string' ? entry : entry?.name;
          const name = cleanDisplayName(raw);
          if (name === '') continue;
          this.names.set(scene, name);
          this.at.set(scene, Number(entry?.at) || 0);
        }
      }
    } catch {
      // A missing or unreadable cache just starts empty.
    } finally {
      this.loaded = true;
    }
    return this;
  }

  /**
   * The remembered name of a scene.
   *
   * @param {string} scene Scene key.
   * @returns {string} Name, or an empty string when unknown.
   */
  get(scene) {
    return this.names.get(String(scene)) ?? '';
  }

  /** How many names are remembered. */
  get size() {
    return this.names.size;
  }

  /**
   * Whether the remembered name is old enough to refresh.
   *
   * @param {string} scene Scene key.
   * @returns {boolean} True when a transport lookup is due.
   */
  stale(scene) {
    return Date.now() - (this.at.get(String(scene)) ?? 0) > NAME_TTL_MS;
  }

  /**
   * Store a name without touching the transport.
   *
   * @param {string} scene Scene key.
   * @param {unknown} name Display name.
   * @returns {boolean} True when the displayed name changed.
   */
  remember(scene, name) {
    const key = String(scene);
    const clean = cleanDisplayName(name);
    if (parseSceneKey(key) === undefined || clean === '') return false;
    const changed = this.names.get(key) !== clean;
    this.names.set(key, clean);
    this.at.set(key, Date.now());
    this.retryAt.delete(key);
    this.dirty = true;
    void this.save();
    return changed;
  }

  /**
   * Store a name only when nothing is known yet.
   *
   * Archive rows and the bridge's group cache are useful seeds, but they must
   * never overwrite a name the transport already answered.
   *
   * @param {string} scene Scene key.
   * @param {unknown} name Seed name.
   * @returns {boolean} True when the seed was stored.
   */
  seed(scene, name) {
    if (this.get(scene) !== '') return false;
    return this.remember(scene, name);
  }

  /**
   * Persist the cache.
   *
   * Writes are chained so two lookups finishing together cannot interleave on
   * the temporary file, and the rename keeps a half-written JSON unreadable
   * only for the moment before the swap.
   *
   * @returns {Promise<void>} Resolves once this write is on disk (or skipped).
   */
  save() {
    if (!this.dirty) return this.saving;
    this.dirty = false;
    const names = {};
    for (const [scene, name] of this.names) {
      names[scene] = { name, at: this.at.get(scene) ?? 0 };
    }
    const body = `${JSON.stringify({ names }, null, 2)}\n`;
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp`;
        await writeFile(temp, body, 'utf8');
        await rename(temp, this.file);
      } catch (error) {
        this.dirty = true;
        this.log(`scene names save failed: ${error?.message ?? error}`);
      }
    });
    return this.saving;
  }

  /**
   * Resolve one scene's name if it is missing or stale, at most once at a time.
   *
   * Failures back off; callers may fire and forget, or await a bounded race
   * when the first paint should already carry real names.
   *
   * @param {string} scene Scene key.
   * @param {{ client?: any, memory?: any }} [source] Transport and memory card.
   * @returns {Promise<boolean>} True when a name is known afterwards.
   */
  ensure(scene, source = {}) {
    const key = String(scene);
    const parsed = parseSceneKey(key);
    if (parsed === undefined) return Promise.resolve(false);
    if (!this.loaded) return this.load().then(() => this.ensure(key, source));
    if (this.names.has(key) && !this.stale(key)) return Promise.resolve(true);
    if ((this.retryAt.get(key) ?? 0) > Date.now()) return Promise.resolve(this.names.has(key));
    const running = this.pending.get(key);
    if (running !== undefined) return running;
    const task = this.#resolve(key, parsed, source)
      .then(() => this.names.has(key))
      .catch(() => {
        this.retryAt.set(key, Date.now() + RETRY_MS);
        return this.names.has(key);
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, task);
    return task;
  }

  /**
   * Ask the transport for one name and remember it.
   *
   * @param {string} scene Scene key.
   * @param {{ kind: 'group' | 'dm', id: number }} parsed Scene parts.
   * @param {{ client?: any, memory?: any }} source Transport and memory card.
   * @returns {Promise<void>} Resolves after the attempt.
   */
  async #resolve(scene, parsed, source) {
    const client = source?.client;
    if (client === undefined || typeof client.call !== 'function') {
      this.retryAt.set(scene, Date.now() + RETRY_MS);
      return;
    }
    if (parsed.kind === 'group') {
      const info = await client.call('get_group_info', { group_id: parsed.id }, { timeoutMs: 5000 });
      const raw = [info?.group_name, info?.data?.group_name]
        .find(value => typeof value === 'string' && value.trim() !== '');
      const name = cleanDisplayName(raw);
      if (name === '') {
        this.retryAt.set(scene, Date.now() + RETRY_MS);
        return;
      }
      this.remember(scene, name);
      await this.save();
      return;
    }
    const info = await client.call('get_stranger_info', { user_id: parsed.id, no_cache: false }, { timeoutMs: 5000 });
    const raw = [info?.remark, info?.data?.remark, info?.nickname, info?.data?.nickname]
      .find(value => typeof value === 'string' && value.trim() !== '');
    const name = cleanDisplayName(raw);
    if (name !== '') {
      this.remember(scene, name);
      await this.save();
      return;
    }
    // Memory is a fallback only: it can lag behind a nickname change, and an
    // old card has been seen to hold a corrupted name.
    const stored = cleanDisplayName(source?.memory?.get?.(parsed.id)?.name);
    if (stored !== '') {
      this.remember(scene, stored);
      await this.save();
      return;
    }
    this.retryAt.set(scene, Date.now() + RETRY_MS);
  }
}
