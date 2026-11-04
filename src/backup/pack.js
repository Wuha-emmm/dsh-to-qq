/**
 * Backup archive creation for dsh-to-qq.
 *
 * A backup is a plain ZIP of the bridge's state directory plus a manifest, so a
 * fresh install on another machine can be brought back to the same chat history,
 * memory cards, sticker catalog and settings with one click.
 *
 * What is portable: JSON state files, the SQLite archive (snapshotted with
 * `VACUUM INTO` so WAL pages are included), and — optionally — preview images.
 * What is not: DSH session ids and the browser profile; both are machine-local
 * and are handled by the restore path rather than copied.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, sep } from 'node:path';
import { createZip } from './zip.js';

/** Bumped when the archive layout changes in a way old plugins cannot read. */
export const BACKUP_FORMAT = 1;

/** State files copied verbatim, in a stable order. */
const STATE_FILES = [
  'config.json',
  'memory.json',
  'stickers.json',
  'sessions.json',
  'guests.json',
  'quota.json',
  'accounts.json',
  'rebuilds.json',
];

/** Per-file ceiling for optional media entries. */
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

/** @param {string} stateDir State directory. @returns {string} Backup directory. */
export function backupDirectory(stateDir) {
  return join(stateDir, 'backups');
}

/**
 * Local timestamp used in backup names: `20261103-013045`.
 *
 * @param {Date} [date] Source date.
 * @returns {string} Compact local timestamp.
 */
export function timestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Read every file under one directory, as `prefix/relative` entries.
 *
 * @param {string} root Directory to walk.
 * @param {string} prefix Entry name prefix.
 * @param {(name: string, size: number) => void} [onSkip] Reports skipped files.
 * @returns {Promise<{ name: string, data: Buffer }[]>} Entries.
 */
async function walk(root, prefix, onSkip) {
  /** @type {{ name: string, data: Buffer }[]} */
  const entries = [];
  let items;
  try {
    items = await readdir(root, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const item of items) {
    const absolute = join(root, item.name);
    const name = `${prefix}/${item.name}`;
    if (item.isDirectory()) {
      entries.push(...await walk(absolute, name, onSkip));
      continue;
    }
    if (!item.isFile()) continue;
    const info = await stat(absolute).catch(() => null);
    if (info === null) continue;
    if (info.size > MAX_MEDIA_BYTES) {
      onSkip?.(name, info.size);
      continue;
    }
    entries.push({ name, data: await readFile(absolute) });
  }
  return entries;
}

/**
 * Create one backup zip.
 *
 * @param {object} options Options.
 * @param {string} options.stateDir State directory.
 * @param {any} [options.archive] Open archive (for a consistent snapshot).
 * @param {any} [options.memory] Memory store, for counts only.
 * @param {any} [options.stickers] Sticker store, for counts only.
 * @param {string} [options.kind] `manual`, `auto` or `pre-restore`.
 * @param {boolean} [options.includeMedia] Include preview/attachment files.
 * @param {boolean} [options.includeCookies] Include signed-in account cookies.
 * @param {string} [options.version] Plugin version written to the manifest.
 * @param {(error: Error) => void} [options.log] Error sink.
 * @returns {Promise<{ name: string, path: string, bytes: number, createdAt: string, counts: object, kind: string }>} Backup info.
 */
export async function createBackup(options) {
  const {
    stateDir,
    archive,
    memory,
    stickers,
    kind = 'manual',
    includeMedia = false,
    includeCookies = true,
    version = '',
    log = () => {},
  } = options;

  const directory = backupDirectory(stateDir);
  await mkdir(directory, { recursive: true });
  const createdAt = new Date();
  const name = `${kind}-${timestamp(createdAt)}.zip`;
  const target = join(directory, name);

  /** @type {{ name: string, data: Buffer }[]} */
  const entries = [];
  for (const file of STATE_FILES) {
    if (file === 'accounts.json' && includeCookies === false) continue;
    try {
      entries.push({ name: file, data: await readFile(join(stateDir, file)) });
    } catch (error) {
      if (error?.code !== 'ENOENT') log(error);
    }
  }

  /** @type {object} */
  const counts = {};
  let archiveIncluded = false;
  if (archive !== null && archive !== undefined && typeof archive.snapshotTo === 'function') {
    const snapshot = join(directory, `.snapshot-${process.pid}-${Date.now()}.db`);
    try {
      archive.snapshotTo(snapshot);
      entries.push({ name: 'archive.db', data: await readFile(snapshot) });
      archiveIncluded = true;
      const stats = archive.stats?.() ?? {};
      counts.messages = Number(stats.messages) || 0;
    } catch (error) {
      log(error);
    } finally {
      await rm(snapshot, { force: true }).catch(() => {});
    }
  }
  if (memory !== undefined && memory !== null) {
    counts.cards = Object.keys(memory.toJSON?.() ?? {}).length;
  }
  if (stickers !== undefined && stickers !== null) {
    counts.stickers = Array.isArray(stickers.all?.()) ? stickers.all().length : 0;
  }

  if (includeMedia === true) {
    const media = await walk(join(stateDir, 'media'), 'media', (entry, size) => {
      log(new Error(`backup skipped ${entry} (${Math.round(size / 1048576)} MB)`));
    });
    entries.push(...media);
    counts.media = media.length;
  }

  const manifest = {
    format: BACKUP_FORMAT,
    plugin: 'dsh-to-qq',
    version,
    createdAt: createdAt.toISOString(),
    machine: hostname(),
    kind,
    options: { media: includeMedia === true, cookies: includeCookies === true },
    archive: archiveIncluded,
    counts,
    files: Object.fromEntries(entries.map(entry => [entry.name, entry.data.length])),
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') });

  const zip = createZip(entries);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, zip);
  await rename(temporary, target);
  return { name, path: target, bytes: zip.length, createdAt: createdAt.toISOString(), counts, kind };
}

/**
 * List backups, newest first.
 *
 * @param {string} stateDir State directory.
 * @returns {Promise<{ name: string, bytes: number, mtime: string, kind: string }[]>} Backups.
 */
export async function listBackups(stateDir) {
  const directory = backupDirectory(stateDir);
  /** @type {{ name: string, bytes: number, mtime: string, kind: string }[]} */
  const rows = [];
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return rows;
  }
  for (const name of names) {
    if (!name.endsWith('.zip')) continue;
    const info = await stat(join(directory, name)).catch(() => null);
    if (info === null || !info.isFile()) continue;
    const kind = name.startsWith('pre-restore-') ? 'pre-restore' : name.startsWith('auto-') ? 'auto' : 'manual';
    rows.push({ name, bytes: info.size, mtime: info.mtime.toISOString(), kind });
  }
  rows.sort((left, right) => right.mtime.localeCompare(left.mtime));
  return rows;
}

/**
 * Delete a backup by name.
 *
 * @param {string} stateDir State directory.
 * @param {string} name Validated file name.
 * @returns {Promise<boolean>} True when a file was removed.
 */
export async function removeBackup(stateDir, name) {
  try {
    await rm(join(backupDirectory(stateDir), name), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep only the newest N automatic backups; manual ones are never pruned.
 *
 * @param {string} stateDir State directory.
 * @param {number} keep How many automatic backups to keep.
 * @returns {Promise<number>} Files removed.
 */
export async function pruneAutoBackups(stateDir, keep) {
  const rows = (await listBackups(stateDir)).filter(row => row.kind === 'auto');
  const limit = Math.max(1, Math.round(Number(keep) || 7));
  let removed = 0;
  for (const row of rows.slice(limit)) {
    if (await removeBackup(stateDir, row.name)) removed += 1;
  }
  return removed;
}

/**
 * Turn an entry name into a safe absolute path under `root`.
 *
 * @param {string} root Destination root.
 * @param {string} name Entry name.
 * @returns {string} Absolute path.
 */
export function inside(root, name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('\0')) {
    throw new Error(`unsafe backup entry: ${name}`);
  }
  const path = join(root, ...normalized.split('/').filter(Boolean));
  const base = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(base)) throw new Error(`unsafe backup entry: ${name}`);
  return path;
}
