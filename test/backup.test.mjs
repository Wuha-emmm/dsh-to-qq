import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, readZip } from '../src/backup/zip.js';
import {
  backupDirectory,
  createBackup,
  inside,
  listBackups,
  pruneAutoBackups,
  removeBackup,
  timestamp,
} from '../src/backup/pack.js';
import { restoreBackup } from '../src/backup/restore.js';

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-to-qq-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function archiveStub(body = 'snapshot-bytes') {
  return {
    closed: false,
    snapshotTo(file) {
      // The real archive runs `VACUUM INTO` synchronously through its SQLite
      // handle, so the stub writes its marker file synchronously as well.
      this.snapshotted = file;
      writeFileSync(file, body);
    },
    stats() {
      return { messages: 7, bytes: 1024 };
    },
    close() {
      this.closed = true;
    },
  };
}

test('zip round-trips UTF-8 names, stored and deflated entries', () => {
  const zip = createZip([
    { name: 'manifest.json', data: Buffer.from('{"a":1}') },
    { name: '记忆/卡片.json', data: Buffer.from('{"记忆":"值"}'.repeat(40)), compress: true },
    { name: 'media/图片.bin', data: Buffer.alloc(2048, 7) },
  ]);
  const files = readZip(zip);
  assert.equal(files.size, 3);
  assert.equal(files.get('manifest.json').toString('utf8'), '{"a":1}');
  assert.equal(files.get('记忆/卡片.json').toString('utf8'), '{"记忆":"值"}'.repeat(40));
  assert.equal(files.get('media/图片.bin').length, 2048);
});

test('zip rejects a corrupted payload instead of returning junk', () => {
  const zip = createZip([{ name: 'a.txt', data: Buffer.from('hello world'.repeat(100)), compress: true }]);
  const damaged = Buffer.from(zip);
  // Flip a byte inside the compressed payload, after the 30-byte local header.
  damaged[45] ^= 0xff;
  assert.throws(() => readZip(damaged), /zip|inflate|crc|invalid/i);
});

test('inside refuses traversal and absolute entries', () => {
  const root = 'C:\\state';
  assert.equal(inside(root, 'media/a.png').endsWith('a.png'), true);
  assert.throws(() => inside(root, '../escape.txt'), /unsafe/);
  assert.throws(() => inside(root, 'media/../../escape.txt'), /unsafe/);
  assert.throws(() => inside(root, '/etc/passwd'), /unsafe/);
});

test('createBackup writes a manifest, honours the cookie switch, and lists', async t => {
  const stateDir = await scratch(t);
  await writeFile(join(stateDir, 'config.json'), '{"connection":{}}');
  await writeFile(join(stateDir, 'memory.json'), '{"cards":{}}');
  await writeFile(join(stateDir, 'accounts.json'), '{"accounts":[]}');
  await mkdir(join(stateDir, 'media'), { recursive: true });
  await writeFile(join(stateDir, 'media', 'preview.png'), Buffer.alloc(32, 1));

  const backup = await createBackup({
    stateDir,
    archive: archiveStub(),
    memory: { toJSON: () => ({ a: {}, b: {} }) },
    stickers: { all: () => [1, 2, 3] },
    version: '0.85.2',
    includeMedia: false,
    includeCookies: false,
  });

  assert.match(backup.name, /^manual-\d{8}-\d{6}\.zip$/);
  const files = readZip(await readFile(backup.path));
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  assert.equal(manifest.plugin, 'dsh-to-qq');
  assert.equal(manifest.version, '0.85.2');
  assert.equal(manifest.archive, true);
  assert.equal(manifest.options.cookies, false);
  assert.equal(manifest.counts.cards, 2);
  assert.equal(manifest.counts.stickers, 3);
  assert.equal(manifest.counts.messages, 7);
  assert.equal(files.has('accounts.json'), false, 'cookies were excluded');
  assert.equal([...files.keys()].some(name => name.startsWith('media/')), false);
  assert.equal(files.has('archive.db'), true);

  const rows = await listBackups(stateDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, backup.name);
  assert.equal(rows[0].kind, 'manual');
  assert.equal(await removeBackup(stateDir, backup.name), true);
  assert.equal((await listBackups(stateDir)).length, 0);
});

test('pruneAutoBackups keeps the newest N and never touches manual ones', async t => {
  const stateDir = await scratch(t);
  const directory = backupDirectory(stateDir);
  await mkdir(directory, { recursive: true });
  const payload = createZip([{ name: 'a.txt', data: Buffer.from('x') }]);
  for (const stamp of ['20260101-000001', '20260101-000002', '20260101-000003', '20260101-000004']) {
    await writeFile(join(directory, `auto-${stamp}.zip`), payload);
  }
  await writeFile(join(directory, 'manual-20260101-000005.zip'), payload);

  const removed = await pruneAutoBackups(stateDir, 2);
  assert.equal(removed, 2);
  const names = (await readdir(directory)).sort();
  assert.equal(names.filter(name => name.startsWith('auto-')).length, 2);
  assert.equal(names.includes('manual-20260101-000005.zip'), true);
});

test('restore dry run reports without touching disk or the bridge', async t => {
  const stateDir = await scratch(t);
  await writeFile(join(stateDir, 'config.json'), '{"old":true}');

  const source = await scratch(t);
  await writeFile(join(source, 'config.json'), '{"restored":true}');
  const backup = await createBackup({ stateDir: source, archive: archiveStub(), version: '0.85.2' });
  const buffer = await readFile(backup.path);

  const bridge = { stopped: false, started: false, stop() { this.stopped = true; }, start() { this.started = true; } };
  const report = await restoreBackup({
    buffer,
    name: backup.name,
    stateDir,
    version: '0.85.2',
    dryRun: true,
    bridge,
    openArchive: async file => ({ file }),
  });

  assert.equal(report.dryRun, true);
  assert.equal(report.files.includes('config.json'), true);
  assert.equal(bridge.stopped, false);
  assert.equal(bridge.started, false);
  assert.equal(await readFile(join(stateDir, 'config.json'), 'utf8'), '{"old":true}');
});

test('restore swaps state, reloads stores and restarts the bridge', async t => {
  const stateDir = await scratch(t);
  await writeFile(join(stateDir, 'config.json'), '{"old":true}');
  await writeFile(join(stateDir, 'sessions.json'), '{"dm:1":"session-1"}');
  await writeFile(join(stateDir, 'memory.json'), '{"cards":{"old":{}}}');
  await writeFile(join(stateDir, 'quota.json'), '{"turns":1}');

  const source = await scratch(t);
  await writeFile(join(source, 'config.json'), '{"restored":true}');
  await writeFile(join(source, 'sessions.json'), '{"dm:1":"session-remote"}');
  await writeFile(join(source, 'memory.json'), '{"cards":{"new":{"note":"hi"}}}');
  await writeFile(join(source, 'quota.json'), '{"turns":9}');
  const backup = await createBackup({ stateDir: source, archive: archiveStub(), version: '0.85.2' });
  const buffer = await readFile(backup.path);

  const bridge = { stopped: false, started: 0, archive: null, stop() { this.stopped = true; }, start() { this.started += 1; } };
  const memory = { loaded: true, reloads: 0, async load() { this.reloads += 1; this.loaded = true; } };
  const quota = { value: null, restore(value) { this.value = value; } };
  const opened = [];
  const report = await restoreBackup({
    buffer,
    name: backup.name,
    stateDir,
    version: '0.85.2',
    bridge,
    openArchive: async file => {
      const handle = { file, closed: false, close() { this.closed = true; } };
      opened.push(handle);
      return handle;
    },
    memory,
    quota,
  });

  assert.equal(report.ok, true);
  assert.match(report.backupBefore, /^pre-restore-/);
  assert.equal(await readFile(join(stateDir, 'config.json'), 'utf8'), '{"restored":true}');
  assert.equal(await readFile(join(stateDir, 'sessions.json'), 'utf8'), '{"dm:1":"session-remote"}');
  assert.equal(memory.reloads, 1);
  assert.deepEqual(quota.value, { turns: 9 });
  assert.equal(bridge.stopped, true);
  assert.equal(bridge.started, 1);
  assert.equal(opened.length, 1);
  assert.equal(bridge.archive, opened[0]);

  const rows = await listBackups(stateDir);
  assert.equal(rows.some(row => row.kind === 'pre-restore'), true);
});

test('restore with clearBindings drops the session map', async t => {
  const stateDir = await scratch(t);
  await writeFile(join(stateDir, 'sessions.json'), '{"dm:1":"session-1"}');

  const source = await scratch(t);
  await writeFile(join(source, 'config.json'), '{}');
  await writeFile(join(source, 'sessions.json'), '{"dm:1":"session-remote"}');
  const backup = await createBackup({ stateDir: source, archive: archiveStub() });

  await restoreBackup({
    buffer: await readFile(backup.path),
    name: backup.name,
    stateDir,
    clearBindings: true,
    bridge: { stop() {}, start() {}, archive: null },
    openArchive: async file => ({ file }),
  });
  assert.equal((await readFile(join(stateDir, 'sessions.json'), 'utf8')).trim(), '{}');
});

test('restore rejects foreign or truncated backups', async t => {
  const stateDir = await scratch(t);
  assert.throws(
    () => readZip(Buffer.from('not a zip at all')),
    /zip|signature|truncated/i,
  );

  const foreign = createZip([{ name: 'manifest.json', data: Buffer.from('{"plugin":"other"}') }]);
  await assert.rejects(
    restoreBackup({
      buffer: foreign,
      stateDir,
      bridge: { stop() {}, start() {} },
      openArchive: async file => ({ file }),
    }),
    /不是 dsh-to-qq/,
  );

  const newer = createZip([{ name: 'manifest.json', data: Buffer.from('{"plugin":"dsh-to-qq","format":99}') }]);
  await assert.rejects(
    restoreBackup({
      buffer: newer,
      stateDir,
      bridge: { stop() {}, start() {} },
      openArchive: async file => ({ file }),
    }),
    /请先升级/,
  );

  const missing = createZip([{ name: 'config.json', data: Buffer.from('{}') }]);
  await assert.rejects(
    restoreBackup({
      buffer: missing,
      stateDir,
      bridge: { stop() {}, start() {} },
      openArchive: async file => ({ file }),
    }),
    /manifest/,
  );
});

test('timestamp uses local time in a sortable shape', () => {
  assert.equal(timestamp(new Date(2026, 10, 3, 1, 30, 45)), '20261103-013045');
});
