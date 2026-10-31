import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge/runtime.js';

const CONFIG = { connection: { botUin: 0 }, access: {}, limits: {}, conversation: {}, memory: {}, stickers: {} };

function makeBridge(stateDir, archiveRows) {
  return new Bridge({
    store: { get: () => CONFIG },
    log: () => {},
    stateDir,
    map: {
      remove: async () => {},
      all: () => ({ 'dm:1': 'session-old' }),
    },
    controller: {
      inspect: async () => ({ events: [] }),
    },
    archive: {
      search: () => archiveRows,
    },
  });
}

test('a rebuild mark survives a restart and the recap is generated later', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-rebuild-'));
  try {
    const rows = [
      { sender_id: 2, sender_name: 'B', time_unix: 200, text: '后来' },
      { sender_id: 1, sender_name: 'A', time_unix: 100, text: '先说' },
    ];
    const first = makeBridge(dir, rows);
    const outcome = await first.rebuildScene('dm:1', { reason: 'test' });
    assert.equal(outcome.messages, 2);
    assert.ok(first.rebuildMarks.has('dm:1'));

    // A fresh bridge — same as a restart — must still remember the mark.
    const second = makeBridge(dir, rows);
    await second.loadRebuildState();
    assert.ok(second.rebuildMarks.has('dm:1'), 'the mark must survive the restart');
    const saved = JSON.parse(await readFile(join(dir, 'rebuilds.json'), 'utf8'));
    assert.equal(typeof saved['dm:1'].at, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a scene with nothing to carry over is rebuilt without a mark', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-rebuild-'));
  try {
    const bridge = makeBridge(dir, []);
    const outcome = await bridge.rebuildScene('dm:1');
    assert.equal(outcome.recapChars, 0);
    assert.equal(bridge.rebuildMarks.has('dm:1'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
