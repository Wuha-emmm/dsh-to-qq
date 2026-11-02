/**
 * Turns that started but were never confirmed as delivered.
 *
 * The reply leaves for QQ long after the prompt is accepted, so a plugin reload
 * or a crash in between loses it silently: the session holds the text, nobody
 * posts it, and the turn never reaches the archive. A record is written when the
 * turn starts, completed once the Host names its session and request, and
 * removed in the turn's `finally` — so whatever survives a reload is exactly the
 * set of turns that may have been dropped.
 *
 * The file only carries scene, session and request ids, never message text, so a
 * copy of it exposes nothing about what was said.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * @typedef {object} PendingTurn
 * @property {string} scene Scene key (`dm:<qq>` or `group:<id>`).
 * @property {string} sessionId Session the turn runs in; empty until bound.
 * @property {string} requestId `qq-…` request id that identifies the turn.
 * @property {number} startedAt Epoch milliseconds when the turn began.
 */

export class PendingTurns {
  /**
   * @param {string} file Absolute path of the JSON file; empty disables it.
   */
  constructor(file) {
    this.file = String(file ?? '');
    /** @type {Map<string, PendingTurn>} Scene -> turn: one scene runs one turn at a time. */
    this.entries = new Map();
    /** @type {Promise<unknown>} Serializes writes so two turns cannot clobber each other. */
    this.writing = Promise.resolve();
    /** @type {boolean} */
    this.ready = false;
  }

  /**
   * Read the leftovers of an interrupted process.
   *
   * @returns {Promise<void>} Resolves once the file was read (a missing file is not an error).
   */
  async #ensure() {
    if (this.ready === true) return;
    this.ready = true;
    if (this.file === '') return;
    try {
      const rows = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        const scene = String(row?.scene ?? '');
        if (scene === '') continue;
        this.entries.set(scene, {
          scene,
          sessionId: String(row?.sessionId ?? ''),
          requestId: String(row?.requestId ?? ''),
          startedAt: Number(row?.startedAt) || 0,
        });
      }
    } catch {
      // A truncated or corrupt record file must not break the bridge: the worst
      // case is one lost recovery, not a plugin that refuses to start.
    }
  }

  /**
   * Record a turn as it starts.
   *
   * @param {string} scene Scene key.
   * @param {number} startedAt Epoch milliseconds.
   * @returns {Promise<void>} Resolves once the record is on disk.
   */
  async begin(scene, startedAt) {
    if (this.file === '') return;
    await this.#ensure();
    this.entries.set(scene, {
      scene,
      sessionId: '',
      requestId: '',
      startedAt: Number(startedAt) || Date.now(),
    });
    await this.#save();
  }

  /**
   * The Host accepted the prompt: remember which session and request own it.
   *
   * @param {string} scene Scene key.
   * @param {string} sessionId Session the turn runs in.
   * @param {string} requestId Request id the turn was started with.
   * @returns {Promise<void>} Resolves once the record is on disk.
   */
  async bind(scene, sessionId, requestId) {
    if (this.file === '') return;
    await this.#ensure();
    const entry = this.entries.get(scene);
    if (entry === undefined) return;
    entry.sessionId = String(sessionId ?? '');
    entry.requestId = String(requestId ?? '');
    await this.#save();
  }

  /**
   * The turn reached its end, delivered or not: no recovery is needed.
   *
   * @param {string} scene Scene key.
   * @returns {Promise<void>} Resolves once the record is gone.
   */
  async finish(scene) {
    if (this.file === '') return;
    await this.#ensure();
    if (this.entries.delete(scene) === false) return;
    await this.#save();
  }

  /**
   * Read every leftover turn and forget it, so recovery cannot run twice.
   *
   * @returns {Promise<PendingTurn[]>} Turns an earlier instance never finished.
   */
  async take() {
    if (this.file === '') return [];
    await this.#ensure();
    const rows = [...this.entries.values()];
    this.entries.clear();
    if (rows.length > 0) await this.#save();
    return rows;
  }

  /**
   * Write the whole record set; a partial file is never visible because the
   * replacement is renamed over the target.
   *
   * @returns {Promise<void>} Resolves once the write queued before it settled.
   */
  async #save() {
    const rows = [...this.entries.values()];
    const run = this.writing.then(async () => {
      if (this.file === '') return;
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, `${JSON.stringify(rows)}\n`, 'utf8');
      await rename(temporary, this.file);
    });
    this.writing = run.catch(() => {});
    return run;
  }
}
