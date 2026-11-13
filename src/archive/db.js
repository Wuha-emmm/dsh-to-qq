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
    CREATE INDEX IF NOT EXISTS messages_scene_msg ON messages (scene, msg_id);
    CREATE INDEX IF NOT EXISTS messages_sender_time ON messages (sender_id, time_unix);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inject_ledger (
      scene TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene TEXT NOT NULL,
      sender_id INTEGER NOT NULL,
      tier TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      prompt_chars INTEGER NOT NULL,
      reply_chars INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_tokens INTEGER NOT NULL DEFAULT 0,
      search_calls INTEGER NOT NULL DEFAULT 0,
      fetch_calls INTEGER NOT NULL DEFAULT 0,
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
  const turnColumns = db.prepare('PRAGMA table_info(turns)').all().map(column => column.name);
  for (const column of ['input_tokens', 'output_tokens', 'cache_tokens', 'search_calls', 'fetch_calls']) {
    if (!turnColumns.includes(column)) db.exec(`ALTER TABLE turns ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
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
   * Display name on the newest inbound message of one scene.
   *
   * Private chats only: the newest inbound sender is the peer, which lets the
   * conversation list show a nickname before the transport answers. For groups
   * this would be whichever member spoke last, so the caller must not use it.
   *
   * @param {string} scene Scene key.
   * @returns {string} Name, or an empty string.
   */
  lastInboundName(scene) {
    try {
      const row = this.db.prepare(`
        SELECT sender_name FROM messages
        WHERE scene = ? AND direction = 'in'
        ORDER BY time_unix DESC, id DESC
        LIMIT 1
      `).get(scene);
      return typeof row?.sender_name === 'string' ? row.sender_name : '';
    } catch {
      return '';
    }
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
   * Read one scene's newest messages shaped like the in-memory context entries.
   *
   * The archive outlives the process, so this is the source the prompt is built
   * from whenever it is available: a restart no longer loses the window, and
   * the dedupe signature can use the real OneBot id instead of a timestamp.
   *
   * @param {string} scene Scene key.
   * @param {number} [limit] Maximum rows.
   * @returns {any[]} Entries oldest-first: senderId/senderName/text/time/messageId/direction.
   */
  recentEntries(scene, limit = 50) {
    const rows = this.db.prepare(`
      SELECT sender_id, sender_name, time_unix, text, direction, media_kind, msg_id
      FROM messages
      WHERE scene = ?
      ORDER BY time_unix DESC, id DESC
      LIMIT ?
    `).all(scene, Math.min(200, Math.max(1, limit)));
    return rows.reverse().map(row => ({
      senderId: Number(row.sender_id) || 0,
      // Our own lines are labelled 我 so the model can tell its words from the
      // group's without counting turns.
      senderName: (row.direction ?? 'in') === 'out' ? '我' : (row.sender_name ?? '对方'),
      text: row.text ?? '',
      time: Number(row.time_unix) || 0,
      messageId: Number(row.msg_id) || 0,
      direction: row.direction ?? 'in',
      mediaKind: row.media_kind ?? undefined,
      mentionsBot: false,
    }));
  }

  /**
   * Read a compact digest of everything older than the live window.
   *
   * The window alone makes the model blind past its edge: it answers "who
   * asked first" from whatever survived. One line per message, truncated,
   * capped, oldest first — cheap enough to send every turn.
   *
   * @param {string} scene Scene key.
   * @param {number} beforeTime Unix seconds; only older rows are returned.
   * @param {number} [limit] Maximum lines.
   * @returns {{ id: number, time: number, name: string, text: string }[]} Digest lines oldest-first.
   */
  digestEntries(scene, beforeTime, limit = 80) {
    const rows = this.db.prepare(`
      SELECT id, sender_name, time_unix, text, direction
      FROM messages
      WHERE scene = ? AND time_unix < ?
      ORDER BY time_unix DESC, id DESC
      LIMIT ?
    `).all(scene, Number(beforeTime) || Number.MAX_SAFE_INTEGER, Math.min(200, Math.max(1, limit)));
    return rows.reverse().map(row => ({
      id: Number(row.id) || 0,
      time: Number(row.time_unix) || 0,
      name: (row.direction ?? 'in') === 'out' ? '我' : (row.sender_name ?? '对方'),
      text: (row.text ?? '').replace(/\s+/g, ' ').slice(0, 40),
    }));
  }

  /**
   * Count everything older than the live window, grouped by speaker.
   *
   * The digest only lists the newest lines; this is what lets the prompt say how
   * much it is quietly leaving out, in one line instead of a thousand.
   *
   * @param {string} scene Scene key.
   * @param {number} beforeTime Unix seconds; only older rows are counted.
   * @returns {{ total: number, first: number, who: { name: string, count: number }[] }} Counts.
   */
  olderStats(scene, beforeTime) {
    const rows = this.db.prepare(`
      SELECT sender_name, direction, COUNT(*) AS n, MIN(time_unix) AS first
      FROM messages
      WHERE scene = ? AND time_unix < ?
      GROUP BY direction, sender_name
      ORDER BY n DESC
    `).all(scene, Number(beforeTime) || Number.MAX_SAFE_INTEGER);
    let total = 0;
    let first = 0;
    const who = [];
    for (const row of rows) {
      const count = Number(row.n) || 0;
      total += count;
      const stamp = Number(row.first) || 0;
      if (stamp > 0 && (first === 0 || stamp < first)) first = stamp;
      who.push({ name: (row.direction ?? 'in') === 'out' ? '我' : (row.sender_name ?? '对方'), count });
    }
    return { total, first, who: who.slice(0, 4) };
  }

  /**
   * Read the persisted injection ledger of one scene.
   *
   * The ledger otherwise lives only in memory, so the first turn after a
   * restart sees a full window again and re-sends it, paying twice for the
   * same lines.
   *
   * @param {string} scene Scene key.
   * @returns {{ sessionId: string, seen: string[], blocks: { slot: string, key: string, hash: string }[] } | undefined} Saved state.
   */
  ledgerLoad(scene) {
    try {
      const row = this.db.prepare('SELECT session_id, body FROM inject_ledger WHERE scene = ?').get(scene);
      if (row === undefined || row === null) return undefined;
      const body = JSON.parse(String(row.body ?? '{}'));
      return {
        sessionId: String(row.session_id ?? ''),
        seen: Array.isArray(body.seen) ? body.seen.map(String) : [],
        blocks: Array.isArray(body.blocks)
          ? body.blocks.map(block => ({ slot: String(block.slot), key: String(block.key), hash: String(block.hash) }))
          : [],
      };
    } catch (error) {
      this.log?.(`ledger load failed: ${error?.message ?? error}`);
      return undefined;
    }
  }

  /**
   * Persist one scene's injection ledger, replacing the previous copy.
   *
   * @param {string} scene Scene key.
   * @param {{ sessionId: string, seen: string[], blocks: { slot: string, key: string, hash: string }[] }} state Ledger state.
   * @returns {boolean} True when written.
   */
  ledgerSave(scene, state) {
    try {
      this.db.prepare(`
        INSERT INTO inject_ledger (scene, session_id, body, at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(scene) DO UPDATE SET session_id = excluded.session_id, body = excluded.body, at = excluded.at
      `).run(
        scene,
        String(state?.sessionId ?? ''),
        JSON.stringify({ seen: state?.seen ?? [], blocks: state?.blocks ?? [] }),
        Date.now(),
      );
      return true;
    } catch (error) {
      this.log?.(`ledger save failed: ${error?.message ?? error}`);
      return false;
    }
  }

  /** @param {string} scene Scene key. @returns {void} */
  ledgerClear(scene) {
    try {
      this.db.prepare('DELETE FROM inject_ledger WHERE scene = ?').run(scene);
    } catch {
      // A missing row is the same as a cleared one.
    }
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
        INSERT INTO turns (scene, sender_id, tier, started_at, duration_ms, prompt_chars, reply_chars,
                           input_tokens, output_tokens, cache_tokens, search_calls, fetch_calls, ok)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        turn.scene,
        turn.senderId,
        turn.tier,
        turn.startedAt,
        turn.durationMs,
        turn.promptChars,
        turn.replyChars,
        Number(turn.inputTokens) || 0,
        Number(turn.outputTokens) || 0,
        Number(turn.cacheTokens) || 0,
        Number(turn.searchCalls) || 0,
        Number(turn.fetchCalls) || 0,
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
  recentTurns(limit = 30) {
    const capped = Math.min(500, Math.max(1, Number(limit) || 30));
    return this.db.prepare(`
      SELECT scene, sender_id, tier, started_at, duration_ms, prompt_chars, reply_chars,
             input_tokens, output_tokens, cache_tokens, search_calls, fetch_calls, ok
      FROM turns ORDER BY started_at DESC LIMIT ?
    `).all(capped);
  }

  /**
   * Token totals from a point in time.
   *
   * @param {number} sinceMs Epoch milliseconds.
   * @returns {{ turns: number, input: number, output: number, cache: number }} Totals.
   */
  /**
   * Every successful turn after a point in time, oldest first.
   *
   * Needed when the unit price depends on when the turn ran.
   *
   * @param {number} sinceMs Epoch milliseconds.
   * @returns {any[]} Rows with tokens and start time.
   */
  turnsSince(sinceMs = 0) {
    return this.db.prepare(`
      SELECT scene, tier, started_at, input_tokens, output_tokens, cache_tokens, search_calls, fetch_calls
      FROM turns WHERE ok = 1 AND started_at >= ? ORDER BY started_at ASC
    `).all(Number(sinceMs) || 0);
  }

  usageTotals(sinceMs = 0) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS turns,
             COALESCE(SUM(input_tokens), 0) AS input,
             COALESCE(SUM(output_tokens), 0) AS output,
             COALESCE(SUM(cache_tokens), 0) AS cache,
             COALESCE(SUM(search_calls), 0) AS search,
             COALESCE(SUM(fetch_calls), 0) AS fetch
      FROM turns WHERE ok = 1 AND started_at >= ?
    `).get(Number(sinceMs) || 0);
    return {
      turns: Number(row?.turns) || 0,
      input: Number(row?.input) || 0,
      output: Number(row?.output) || 0,
      cache: Number(row?.cache) || 0,
      search: Number(row?.search) || 0,
      fetch: Number(row?.fetch) || 0,
    };
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
    const sql = `SELECT scene, sender_id, sender_name, time_unix, time_bj, text, msg_id, reply_to, media_kind, media_path, direction
                 FROM messages ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY time_unix DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, limit);
  }

  /**
   * Look one message up by its OneBot id inside a scene.
   *
   * Quotes of our own replies used to be unresolvable: the scene buffer only
   * keeps what came in, and SnowLuma never echoes our own sends. The archive
   * has both directions, so it can answer for the missing side.
   *
   * @param {string} scene Scene key such as `group:123`.
   * @param {number} msgId OneBot message id.
   * @returns {any|undefined} The row, newest first if duplicated.
   */
  byMessageId(scene, msgId) {
    const id = Number(msgId);
    if (!Number.isFinite(id) || id <= 0) return undefined;
    return this.db.prepare(`
      SELECT scene, sender_id, sender_name, time_unix, time_bj, text, msg_id, reply_to, media_kind, media_path, direction
      FROM messages
      WHERE scene = ? AND msg_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(scene, id);
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

  /**
   * Write a consistent copy of the database to `file`.
   *
   * The archive runs in WAL mode, so copying `archive.db` on its own can miss
   * pages still living in the `-wal` file. `VACUUM INTO` produces a single
   * self-contained database with the same rows, which is what a backup needs.
   *
   * @param {string} file Destination path; must not exist.
   * @returns {void}
   */
  snapshotTo(file) {
    const target = String(file).replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${target}'`);
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


