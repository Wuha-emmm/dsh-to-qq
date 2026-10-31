import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge/runtime.js';

function makeBridge(dir, archived, conversation) {
  return new Bridge({
    store: { get: () => ({ connection: { botUin: 0 }, access: {}, limits: {}, conversation, memory: {}, stickers: {} }) },
    log: () => {},
    stateDir: dir,
    map: { get: () => 'session-old', remove: async () => {}, all: () => ({ 'dm:1': 'session-old' }) },
    controller: { inspect: async () => ({ events: [] }) },
    archive: { search: () => [{ sender_name: 'A', text: 'hi' }] },
    archiveSession: async id => { archived.push(id); },
  });
}

test('a rebuild hides the replaced session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-arch-'));
  try {
    const archived = [];
    await makeBridge(dir, archived, { archiveOldSessions: true }).rebuildScene('dm:1');
    assert.deepEqual(archived, ['session-old']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('archiveOldSessions = false keeps the replaced session visible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-arch-'));
  try {
    const archived = [];
    await makeBridge(dir, archived, { archiveOldSessions: false }).rebuildScene('dm:1');
    assert.deepEqual(archived, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failing archive hook does not break the rebuild', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-arch-'));
  try {
    const bridge = new Bridge({
      store: { get: () => ({ connection: { botUin: 0 }, access: {}, limits: {}, conversation: { archiveOldSessions: true }, memory: {}, stickers: {} }) },
      log: () => {},
      stateDir: dir,
      map: { get: () => 'session-old', remove: async () => {}, all: () => ({}) },
      controller: { inspect: async () => ({ events: [] }) },
      archive: { search: () => [{ sender_name: 'A', text: 'hi' }] },
      archiveSession: async () => { throw new Error('workspace missing'); },
    });
    const outcome = await bridge.rebuildScene('dm:1');
    assert.equal(outcome.messages, 1);
    assert.ok(bridge.rebuildMarks.has('dm:1'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
