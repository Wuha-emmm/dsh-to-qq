import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneMedia } from '../src/media/prune.js';

test('pruneMedia removes only files older than the window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-prune-'));
  try {
    const old = join(dir, 'old.png');
    const fresh = join(dir, 'fresh.png');
    await writeFile(old, 'x');
    await writeFile(fresh, 'y');
    const now = Date.now();
    const oldSeconds = (now - 10 * 24 * 3600 * 1000) / 1000;
    await utimes(old, oldSeconds, oldSeconds);

    const removed = await pruneMedia(dir, 7, { now });
    assert.equal(removed, 1);
    const remaining = await import('node:fs/promises').then(fs => fs.readdir(dir));
    assert.deepEqual(remaining, ['fresh.png']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a zero-day window keeps everything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-prune-'));
  try {
    const file = join(dir, 'a.png');
    await writeFile(file, 'x');
    const past = (Date.now() - 30 * 24 * 3600 * 1000) / 1000;
    await utimes(file, past, past);
    assert.equal(await pruneMedia(dir, 0), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing directory is not an error', async () => {
  assert.equal(await pruneMedia(join(tmpdir(), 'dsh-to-qq-does-not-exist'), 7), 0);
  assert.equal(await pruneMedia('', 7), 0);
});
