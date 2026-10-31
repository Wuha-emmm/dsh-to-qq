import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge/runtime.js';

const HOUR = 3600_000;

function makeBridge(dir, archived) {
  const items = [
    { sessionId: 'session-old', updatedAt: Date.now() - 48 * HOUR, running: false, blank: false, cwd: 'E:\\DSH-to-QQ' },
    { sessionId: 'session-group', updatedAt: Date.now() - 48 * HOUR, running: false, blank: false, cwd: 'E:\\DSH-to-QQ' },
    { sessionId: 'session-fresh', updatedAt: Date.now() - 60_000, running: false, blank: false, cwd: 'E:\\DSH-to-QQ' },
    { sessionId: 'session-other', updatedAt: Date.now() - 48 * HOUR, running: false, blank: false, cwd: 'D:\\elsewhere' },
  ];
  return new Bridge({
    store: { get: () => ({ connection: { botUin: 0 }, access: {}, limits: {}, conversation: { cwd: 'E:\\DSH-to-QQ', cleanupKeepHours: 24, archiveOldSessions: true }, memory: {}, stickers: {} }) },
    log: () => {},
    stateDir: dir,
    map: { all: () => ({ 'dm:1': 'session-dm' }), get: () => undefined, remove: async () => {} },
    driver: { guestStore: { all: () => ({ 'session-group': 'owner-group' }) } },
    controller: { list: async () => ({ sessions: items }), inspect: async () => ({ events: [] }) },
    archiveSession: async id => { archived.push(id); },
  });
}

test('cleanup reads the controller summary shape and protects guest sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-clean-'));
  try {
    const archived = [];
    const bridge = makeBridge(dir, archived);
    const preview = await bridge.cleanupSessions({ dry: true });
    assert.deepEqual(preview.candidates.map(item => item.id), ['session-old'], 'sessionId rows must be understood');
    assert.equal(preview.bound, 2, 'the dm binding and the guest group both count');
    assert.equal(preview.archived, 0, 'a dry run archives nothing');

    const run = await bridge.cleanupSessions({});
    assert.deepEqual(archived, ['session-old']);
    assert.equal(run.archived, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
