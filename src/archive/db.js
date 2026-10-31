/**
 * Message archive.
 *
 * Every inbound message is stored before any filtering, so the archive is the
 * ground truth for "what was said" — context windows, "find that image from
 * yesterday", and cleanup all read from here.
 *
 * `node:sqlite` is loaded dynamically: if the host runtime lacks it, the archive
 * disables itself and the rest of the bridge keeps working.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Current schema version; bump when the table layout changes. */
const SCHEMA_VERSION = 1;

/**
 * @typedef {object} ArchiveRecord
 * @property {string} key Unique `selfId:messageId`.
 * @property {number} selfId Bot account.
 * @property {'dm' | 'group'} kind Scene kind.
 * @property {string} scene Scene key.
 * @property {number} peerId Counterpart user id, or group id.
 * @property {number | undefined} groupId Group id for group messages.
 * @property {number} senderId Sender QQ.
 * @property {string} senderName Display name at that moment.
 * @property {number} time Unix seconds.
 * @property {string} text Flattened text.
 * @property {number} messageId OneBot message id.
 * @property {string | undefined} replyTo Quoted message id.
 */

/**
 * Open the archive, creating the file and schema when needed.
 *
 * @param {string} file Absolute path to archive.db.
 * @returns {Promise<Archive | null>} The archive, or null when SQLite is unavailable.
 */
export async function openArchive(file) {
  /** @type {any} */
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null;
  }
  if (typeof DatabaseSync !== 'function') return null;

  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      self_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      scene TEXT NOT NULL,
      peer_id INTEGER NOT NULL,
      group_id INTEGER,
      sender_id INTEGER NOT NULL,
      sender_name TEXT NOT NULL,
      time_unix INTEGER NOT NULL,
      time_bj TEXT NOT NULL,
      text TEXT NOT NULL,
      msg_id INTEGER NOT NULL,
      reply_to TEXT,
      media_kind TEXT,
      direction TEXT NOT NULL DEFAULT 'in',
      reasoning TEXT,
      media_path TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_scene_time ON messages (scene, time_unix);
    CREATE INDEX IF NOT EXISTS messages_sender_time ON messages (sender_id, time_unix);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene TEXT NOT NULL,
      sender_id INTEGER NOT NULL,
      tier TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      prompt_chars INTEGER NOT NULL,
      reply_chars INTEGER NOT NULL,
      ok INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turns_started ON turns (started_at);
  `);
  // Migrations for archives created by earlier versions.
  const columns = db.prepare('PRAGMA table_info(messages)').all().map(column => column.name);
  if (!columns.includes('direction')) {
    db.exec("ALTER TABLE messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'");
  }
  if (!columns.includes('reasoning')) {
    db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT');
  }
  if (!columns.includes('media_path')) {
    db.exec('ALTER TABLE messages ADD COLUMN media_path TEXT');
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));
  return new Archive(db);
}

/**
 * Format a Unix second timestamp as Beijing wall-clock time.
 *
 * @param {number} unixSeconds Unix seconds.
 * @returns {string} `YYYY-MM-DD HH:mm:ss`.
 */
export function beijingTime(unixSeconds) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(unixSeconds * 1000));
  const get = type => parts.find(part => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Synchronous wrapper around one SQLite connection. */
class Archive {
  /**
   * @param {any} db An open `node:sqlite` database.
   */
  constructor(db) {
    this.db = db;
    this.inserted = 0;
  }

  /**
   * Store one message; a repeated key is ignored.
   *
   * @param {ArchiveRecord} record The message.
   * @returns {boolean} True when a new row was written.
   */
  insert(record) {
    try {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO messages
          (key, self_id, kind, scene, peer_id, group_id, sender_id, sender_name, time_unix, time_bj, text, msg_id, reply_to, media_kind, direction, reasoning, media_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.key,
        record.selfId,
        record.kind,
        record.scene,
        record.peerId,
        record.groupId ?? null,
        record.senderId,
        record.senderName,
        record.time,
        beijingTime(record.time),
        record.text,
        record.messageId,
        record.replyTo ?? null,
        record.mediaKind ?? null,
        record.direction ?? 'in',
        record.reasoning ?? null,
        record.mediaPath ?? null,
      );
      if (result.changes > 0) this.inserted += 1;
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  /**
   * List scenes with their latest activity.
   *
   * @returns {any[]} One row per scene, most recently active first.
   */
  /** Cached scene rollup: the panel polls this every few seconds. */
  #scenesCache = null;

  /**
   * Per-scene totals, newest activity first.
   *
   * @param {number} [maxAgeMs] Cache lifetime in milliseconds.
   * @returns {any[]} One row per scene.
   */
  scenes(maxAgeMs = 30_000) {
    const now = Date.now();
    if (this.#scenesCache !== null && now - this.#scenesCache.at < maxAgeMs) return this.#scenesCache.rows;
    const rows = this.db.prepare(`
      SELECT scene, kind, MAX(time_unix) AS last_unix, MAX(time_bj) AS last_bj, COUNT(*) AS total
      FROM messages
      GROUP BY scene
      ORDER BY last_unix DESC
    `).all();
    this.#scenesCache = { at: now, rows };
    return rows;
  }

  /**
   * Read the newest messages of one scene, oldest first.
   *
   * @param {string} scene Scene key.
   * @param {number} [limit] Maximum rows.
   * @returns {any[]} Messages ready for rendering.
   */
  recent(scene, limit = 50) {
    const rows = this.db.prepare(`
      SELECT sender_id, sender_name, time_bj, text, direction, media_kind, msg_id, reasoning
      FROM messages
      WHERE scene = ?
      ORDER BY time_unix DESC, id DESC
      LIMIT ?
    `).all(scene, Math.min(200, Math.max(1, limit)));
    return rows.reverse();
  }

  /**
   * Record one answered turn for auditing.
   *
   * @param {{ scene: string, senderId: number, tier: string, startedAt: number, durationMs: number, promptChars: number, replyChars: number, ok: boolean }} turn Turn facts.
   * @returns {boolean} True when the row was written.
   */
  insertTurn(turn) {
    try {
      this.db.prepare(`
        INSERT INTO turns (scene, sender_id, tier, started_at, duration_ms, prompt_chars, reply_chars, ok)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        turn.scene,
        turn.senderId,
        turn.tier,
        turn.startedAt,
        turn.durationMs,
        turn.promptChars,
        turn.replyChars,
        turn.ok ? 1 : 0,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Link saved media files to the message they came from.
   *
   * @param {string} key Message key.
   * @param {string} path Absolute paths joined by ';'.
   * @returns {boolean} True when the row was updated.
   */
  attachMedia(key, path) {
    const joined = String(path ?? '').trim();
    if (joined === '') return false;
    try {
      const result = this.db.prepare('UPDATE messages SET media_path = ? WHERE key = ?').run(joined, String(key));
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  /**
   * Read the most recent turns, newest first.
   *
   * @param {number} [limit] Maximum rows.
   * @returns {any[]} Turn rows.
   */
  recentTurns(limit = 20) {
    return this.db.prepare(`
      SELECT scene, sender_id, tier, started_at, duration_ms, prompt_chars, reply_chars, ok
      FROM turns ORDER BY started_at DESC LIMIT ?
    `).all(Math.min(200, Math.max(1, limit)));
  }

  /**
   * Search the archive.
   *
   * @param {object} query Filters.
   * @param {string} [query.scene] Exact scene key.
   * @param {string} [query.kind] `dm` or `group`.
   * @param {number} [query.senderId] Exact sender.
   * @param {number} [query.since] Unix seconds lower bound.
   * @param {string} [query.keyword] Substring match on text.
   * @param {number} [query.limit] Maximum rows.
   * @returns {any[]} Matching rows, newest first.
   */
  search(query = {}) {
    const where = [];
    const params = [];
    if (typeof query.scene === 'string') {
      where.push('scene = ?');
      params.push(query.scene);
    }
    if (typeof query.kind === 'string') {
      where.push('kind = ?');
      params.push(query.kind);
    }
    if (Number.isInteger(query.senderId)) {
      where.push('sender_id = ?');
      params.push(query.senderId);
    }
    if (Number.isFinite(query.since)) {
      where.push('time_unix >= ?');
      params.push(Math.floor(query.since));
    }
    if (typeof query.keyword === 'string' && query.keyword !== '') {
      where.push('text LIKE ?');
      params.push(`%${query.keyword}%`);
    }
    const limit = Number.isInteger(query.limit) ? Math.min(20_000, Math.max(1, query.limit)) : 20;
    const sql = `SELECT scene, sender_id, sender_name, time_unix, time_bj, text, msg_id, media_kind, media_path, direction
                 FROM messages ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY time_unix DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, limit);
  }

  /**
   * Read one person's messages after a cursor, oldest first.
   *
   * Used by the impression summarizer: it must read everything a person said,
   * in every scene, and never re-read what it already processed.
   *
   * @param {number} senderId QQ number.
   * @param {number} sinceUnix Unix seconds; rows strictly newer are returned.
   * @param {number} [limit] Maximum rows to read.
   * @returns {any[]} Rows in chronological order.
   */
  senderMessages(senderId, sinceUnix, limit = 400) {
    const capped = Math.min(2000, Math.max(1, Number(limit) || 400));
    const since = Math.max(0, Math.floor(Number(sinceUnix) || 0));
    return this.db.prepare(`
      SELECT scene, sender_id, sender_name, time_unix, time_bj, text, media_kind
      FROM messages
      WHERE sender_id = ? AND time_unix > ? AND direction = 'in'
      ORDER BY time_unix ASC LIMIT ?
    `).all(senderId, since, capped);
  }

  /**
   * Read one person's newest messages, oldest first.
   *
   * Used for a first impression: it should reflect how they talk now, not how
   * they talked months ago, so the window starts from the newest end.
   *
   * @param {number} senderId QQ number.
   * @param {number} [limit] Maximum rows to read.
   * @returns {any[]} Rows in chronological order.
   */
  latestSenderMessages(senderId, limit = 200) {
    const capped = Math.min(2000, Math.max(1, Number(limit) || 200));
    const rows = this.db.prepare(`
      SELECT scene, sender_id, sender_name, time_unix, time_bj, text, media_kind
      FROM messages
      WHERE sender_id = ? AND direction = 'in'
      ORDER BY time_unix DESC LIMIT ?
    `).all(senderId, capped);
    return rows.reverse();
  }

  /**
   * Every QQ number that has ever spoken.
   *
   * @returns {number[]} Distinct sender ids.
   */
  distinctSenders() {
    return this.db.prepare(`
      SELECT DISTINCT sender_id FROM messages
      WHERE direction = 'in' AND sender_id > 0
    `).all().map(row => Number(row.sender_id)).filter(id => Number.isInteger(id) && id > 0);
  }

  /**
   * Delete rows older than a retention window.
   *
   * @param {number} days Days to keep; 0 disables cleanup.
   * @returns {number} Rows removed.
   */
  prune(days) {
    if (!(days > 0)) return 0;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    return Number(this.db.prepare('DELETE FROM messages WHERE time_unix < ?').run(Math.floor(cutoff)).changes) || 0;
  }

  /** @returns {{ messages: number, bytes: number }} Row count and file size. */
  stats() {
    const messages = this.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    const pageSize = this.db.prepare('PRAGMA page_size').get().page_size;
    const pageCount = this.db.prepare('PRAGMA page_count').get().page_count;
    return { messages: Number(messages), bytes: Number(pageSize) * Number(pageCount) };
  }

  /** Close the connection. */
  close() {
    try {
      this.db.close();
    } catch {
      // Closing twice is harmless.
    }
  }
}


