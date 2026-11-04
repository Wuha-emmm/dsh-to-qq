/**
 * Restore a dsh-to-qq backup into the live plugin.
 *
 * The hard part is not copying files: it is replacing the SQLite archive while
 * the bridge holds it open, and waking the in-memory stores up on the new
 * contents afterwards. The sequence is therefore:
 *
 *   snapshot current state → stop transport → close archive → swap files →
 *   reopen archive → reload stores → start transport
 *
 * Any failure rolls the swapped files back and restarts the bridge, so a bad
 * zip leaves the bridge exactly as it was.
 */

import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readZip } from './zip.js';
import { BACKUP_FORMAT, createBackup, inside, timestamp } from './pack.js';

/** Files a restore may replace. Anything else in the zip is ignored. */
const TARGETS = [
  'config.json',
  'memory.json',
  'stickers.json',
  'sessions.json',
  'guests.json',
  'quota.json',
  'accounts.json',
  'rebuilds.json',
  'archive.db',
];

/**
 * Whether a path exists.
 *
 * @param {string} path Absolute path.
 * @returns {Promise<boolean>} True when present.
 */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore a backup.
 *
 * @param {object} options Options.
 * @param {Buffer} options.buffer Zip bytes.
 * @param {string} options.name File name, for reporting.
 * @param {string} options.stateDir State directory.
 * @param {string} [options.version] Current plugin version.
 * @param {boolean} [options.dryRun] Only report what would change.
 * @param {boolean} [options.clearBindings] Drop QQ scene to DSH session bindings.
 * @param {any} options.bridge Bridge instance (stopped and restarted).
 * @param {any} [options.archive] Currently open archive.
 * @param {(file: string) => Promise<any>} options.openArchive Archive opener.
 * @param {any} [options.memory] Memory store.
 * @param {any} [options.stickers] Sticker store.
 * @param {any} [options.map] Session map.
 * @param {any} [options.guestStore] Guest session map.
 * @param {any} [options.accounts] Account store.
 * @param {any} [options.store] Config store.
 * @param {any} [options.quota] Quota counters.
 * @param {(error: Error) => void} [options.log] Error sink.
 * @returns {Promise<object>} Restore report.
 */
export async function restoreBackup(options) {
  const {
    buffer,
    name = 'upload.zip',
    stateDir,
    version = '',
    dryRun = false,
    clearBindings = false,
    bridge,
    archive,
    openArchive,
    memory,
    stickers,
    map,
    guestStore,
    accounts,
    store,
    quota,
    log = () => {},
  } = options;

  const files = readZip(buffer);
  const manifestBytes = files.get('manifest.json');
  if (manifestBytes === undefined) throw new Error('备份缺少 manifest.json，可能不是 dsh-to-qq 的备份');
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('备份的 manifest.json 无法解析');
  }
  if (manifest.plugin !== 'dsh-to-qq') throw new Error('这不是 dsh-to-qq 的备份');
  if (!Number.isInteger(manifest.format) || manifest.format > BACKUP_FORMAT) {
    throw new Error(`备份格式 ${String(manifest.format)} 来自更新的插件，请先升级 dsh-to-qq`);
  }

  const warnings = [];
  if (typeof manifest.version === 'string' && manifest.version !== '' && version !== '' && manifest.version !== version) {
    warnings.push(`备份来自 ${manifest.version}，当前是 ${version}`);
  }
  if (manifest.archive !== true) warnings.push('备份里没有消息档案（宿主缺少 node:sqlite）');

  const present = TARGETS.filter(file => files.has(file));
  const media = [...files.keys()].filter(file => file.startsWith('media/')).length;
  const counts = manifest.counts ?? {};
  const summary = {
    name,
    createdAt: manifest.createdAt ?? '',
    version: manifest.version ?? '',
    machine: manifest.machine ?? '',
    counts,
    files: present,
    media,
    warnings,
  };
  if (dryRun === true) return { dryRun: true, ...summary };

  // A snapshot of the current state first: a restore that goes wrong must be
  // undoable from the panel with the same button.
  const before = await createBackup({
    stateDir,
    archive,
    memory,
    stickers,
    kind: 'pre-restore',
    includeMedia: false,
    includeCookies: true,
    version,
    log,
  }).catch(error => {
    log(error);
    return null;
  });

  const stash = join(stateDir, `.restore-${timestamp()}`);
  await mkdir(stash, { recursive: true });
  /** @type {{ target: string, backup: string | null }[]} */
  const swapped = [];

  try {
    bridge?.stop?.();
    archive?.close?.();
    if (bridge !== null && bridge !== undefined) bridge.archive = null;

    for (const file of present) {
      const target = inside(stateDir, file);
      let backup = null;
      if (await exists(target)) {
        backup = join(stash, file);
        await rename(target, backup);
      }
      if (file === 'archive.db') {
        await rm(`${target}-wal`, { force: true });
        await rm(`${target}-shm`, { force: true });
      }
      await writeFile(target, files.get(file));
      swapped.push({ target, backup });
    }

    for (const [entry, data] of files) {
      if (!entry.startsWith('media/')) continue;
      const target = inside(join(stateDir, 'media'), entry.slice('media/'.length));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }

    if (clearBindings === true) {
      await writeFile(join(stateDir, 'sessions.json'), '{}\n', 'utf8');
    }

    // Re-read everything from disk: the stores cache their contents and would
    // otherwise keep serving the pre-restore objects.
    for (const item of [store, memory, stickers, map, guestStore, accounts]) {
      if (item === null || item === undefined || typeof item.load !== 'function') continue;
      item.loaded = false;
      await item.load().catch(error => log(error));
    }
    if (files.has('quota.json') && quota !== null && quota !== undefined) {
      try {
        quota.restore(JSON.parse(files.get('quota.json').toString('utf8')));
      } catch (error) {
        log(error);
      }
    }
    const opened = await openArchive(join(stateDir, 'archive.db'));
    if (bridge !== null && bridge !== undefined) bridge.archive = opened;
    // The in-memory injection ledger describes a database that no longer
    // exists: drop it before the next turn reads the restored rows.
    await bridge?.afterRestore?.();
    bridge?.start?.();
    await rm(stash, { recursive: true, force: true }).catch(() => {});
    return { ok: true, ...summary, restored: present, backupBefore: before?.name ?? '' };
  } catch (error) {
    // Put every swapped file back, reopen the archive, and let the bridge run.
    for (const item of swapped.reverse()) {
      await rm(item.target, { force: true }).catch(() => {});
      if (item.backup !== null) await rename(item.backup, item.target).catch(() => {});
    }
    try {
      const opened = await openArchive(join(stateDir, 'archive.db'));
      if (bridge !== null && bridge !== undefined) bridge.archive = opened;
      bridge?.start?.();
    } catch (reopenError) {
      log(reopenError);
    }
    throw error;
  }
}
