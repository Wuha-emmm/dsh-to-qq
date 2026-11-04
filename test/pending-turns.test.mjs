import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PendingTurns } from '../src/bridge/pending-turns.js';

test('a turn is recorded at start, bound at prompt, and gone after it finishes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const file = join(dir, 'pending-turns.json');
    const turns = new PendingTurns(file);

    await turns.begin('group:661526815', 1_700_000_000_000);
    const early = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(early.length, 1);
    assert.equal(early[0].scene, 'group:661526815');
    assert.equal(early[0].sessionId, '', 'the session is unknown until the prompt is accepted');
    assert.equal(early[0].requestId, '');

    await turns.bind('group:661526815', 'session-1', 'qq-abc');
    const bound = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(bound[0].sessionId, 'session-1');
    assert.equal(bound[0].requestId, 'qq-abc');

    await turns.finish('group:661526815');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [], 'a finished turn leaves no record');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('take() hands the leftovers over once and clears the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const file = join(dir, 'pending-turns.json');
    const first = new PendingTurns(file);
    await first.begin('dm:10000000', 1_700_000_000_000);
    await first.bind('dm:10000000', 'session-9', 'qq-lost');

    // A reload: the next instance reads what the first one left behind.
    const second = new PendingTurns(file);
    const rows = await second.take();
    assert.deepEqual(rows, [{
      scene: 'dm:10000000',
      sessionId: 'session-9',
      requestId: 'qq-lost',
      startedAt: 1_700_000_000_000,
    }]);
    assert.deepEqual(await second.take(), [], 'a recovery must not run twice');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt record file is ignored instead of breaking the bridge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const file = join(dir, 'pending-turns.json');
    await writeFile(file, '{"half":', 'utf8');
    const turns = new PendingTurns(file);
    assert.deepEqual(await turns.take(), []);
    await turns.begin('dm:1', 1_700_000_000_000);
    assert.equal((await readFile(file, 'utf8')).includes('dm:1'), true, 'the file is rebuilt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty path disables the store without throwing', async () => {
  const turns = new PendingTurns('');
  await turns.begin('dm:1', 1);
  await turns.bind('dm:1', 's', 'qq-1');
  await turns.finish('dm:1');
  assert.deepEqual(await turns.take(), []);
});
