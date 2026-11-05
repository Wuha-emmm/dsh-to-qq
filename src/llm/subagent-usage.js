/**
 * Token usage of subagents, read straight from the Host's session cache.
 *
 * Subagents never pass through the bridge: they are separate DSH sessions, so
 * `archive.db` has no row for them and the usage page used to under-report by
 * whatever a delegated job cost. The Host does cache every session's running
 * totals under `<profile>/storages/session_projcache/sessions/*.json`, and a
 * subagent is recognisable by the parent hand-off line the Host appends to its
 * first prompt, so this module folds those files back into the same price
 * schedule the normal rows use.
 *
 * Files are re-parsed only when their mtime or size changed, because the page
 * polls every few seconds and a session file can be megabytes.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateCost } from './cost.js';

/** Marker the Host writes into a delegated session's first prompt. */
const PARENT_MARKER = 'Your parent agent id is';

/**
 * Where the Host keeps its session cache.
 *
 * @param {string} profileDir Absolute profile directory (`~/.dsh` and friends).
 * @returns {string} Directory holding one JSON file per session.
 */
export function sessionCacheDir(profileDir) {
  return join(profileDir, 'storages', 'session_projcache', 'sessions');
}

/**
 * Extracts what the usage page needs from one cached session file.
 *
 * @param {string} name File name, used as the session id.
 * @param {string} text Raw file content.
 * @returns {{ id: string, title: string, createdAt: number, input: number, output: number, cache: number } | null}
 *   The session, or null when the file is not a subagent or carries no totals.
 */
export function parseSubagentSession(name, text) {
  if (!text.includes(PARENT_MARKER)) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const rows = data?.record?.rows;
  const totals = rows?.tokenUsage?.val?.totals;
  if (totals === undefined || totals === null) return null;
  const createdAt = Number(data?.record?.identity?.createdAt) || 0;
  const title = typeof rows?.title?.val === 'string' ? rows.title.val : '';
  return {
    id: name.replace(/\.json$/u, ''),
    title: title.slice(0, 60),
    createdAt,
    input: Number(totals.uncachedInputTokens) || 0,
    output: Number(totals.outputTokens) || 0,
    cache: Number(totals.cacheReadTokens) || 0,
  };
}

/** @type {Map<string, { mtimeMs: number, size: number, value: ReturnType<typeof parseSubagentSession> }>} */
const cache = new Map();

/**
 * Sums subagent usage and prices it with the same schedule as the turn rows.
 *
 * @param {{ dir: string, prices: Record<string, unknown>, sinceMs?: number }} options
 *   Session cache directory, price schedule, and an optional lower bound on the
 *   session's creation time.
 * @returns {Promise<{
 *   sessions: Array<{ id: string, title: string, createdAt: number, input: number, output: number, cache: number, cost: number | null }>,
 *   totals: { sessions: number, input: number, output: number, cache: number, cost: number | null },
 *   scanned: number,
 * }>}
 */
export async function collectSubagentUsage({ dir, prices, sinceMs = 0 }) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return { sessions: [], totals: { sessions: 0, input: 0, output: 0, cache: 0, cost: 0 }, scanned: 0 };
  }
  const found = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    let entry = cache.get(file);
    if (entry === undefined || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
      let value = null;
      try {
        value = parseSubagentSession(name, await readFile(file, 'utf8'));
      } catch {
        value = null;
      }
      entry = { mtimeMs: info.mtimeMs, size: info.size, value };
      cache.set(file, entry);
    }
    if (entry.value === null || entry.value.createdAt < sinceMs) continue;
    found.push(entry.value);
  }
  found.sort((left, right) => right.createdAt - left.createdAt);
  const sessions = found.map(item => {
    const estimate = estimateCost(
      { inputTokens: item.input, outputTokens: item.output, cacheReadTokens: item.cache },
      prices,
      item.createdAt,
    );
    return { ...item, cost: estimate.cost };
  });
  const totals = {
    sessions: sessions.length,
    input: sessions.reduce((sum, item) => sum + item.input, 0),
    output: sessions.reduce((sum, item) => sum + item.output, 0),
    cache: sessions.reduce((sum, item) => sum + item.cache, 0),
    cost: null,
  };
  totals.cost = sessions.every(item => item.cost !== null)
    ? sessions.reduce((sum, item) => sum + (item.cost ?? 0), 0)
    : null;
  return { sessions, totals, scanned: names.length };
}
