import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupCandidates, extractSessions } from '../src/bridge/commands.js';

const DAY = 24 * 3600_000;
const NOW = 1_000_000_000;

function items() {
  return [
    { id: 'old', updatedAt: NOW - 2 * DAY, cwd: 'E:\\work\\qq-bridge' },
    { id: 'bound', updatedAt: NOW - 3 * DAY, cwd: 'E:\\work\\qq-bridge' },
    { id: 'fresh', updatedAt: NOW - 60_000, cwd: 'E:\\work\\qq-bridge' },
    { id: 'elsewhere', updatedAt: NOW - 5 * DAY, cwd: 'E:\\other-work' },
    { id: 'running', updatedAt: NOW - 5 * DAY, cwd: 'E:\\work\\qq-bridge', running: true },
    { id: 'archived', updatedAt: NOW - 5 * DAY, cwd: 'E:\\work\\qq-bridge', archived: true },
  ];
}

test('cleanup only takes old, idle, unbound sessions in the bridge folder', () => {
  const picked = cleanupCandidates(items(), {
    bound: new Set(['bound']),
    keepMs: DAY,
    cwd: 'e:\\work\\qq-bridge',
    now: NOW,
  });
  assert.deepEqual(picked.map(item => item.id), ['old']);
});

test('an empty cwd filter keeps sessions from every folder', () => {
  const picked = cleanupCandidates(items(), { bound: new Set(['bound']), keepMs: DAY, cwd: '', now: NOW });
  assert.deepEqual(picked.map(item => item.id).sort(), ['elsewhere', 'old']);
});

test('the oldest candidates come first', () => {
  const picked = cleanupCandidates(
    [
      { id: 'newer', updatedAt: NOW - 2 * DAY, cwd: 'x' },
      { id: 'oldest', updatedAt: NOW - 9 * DAY, cwd: 'x' },
    ],
    { bound: new Set(), keepMs: DAY, cwd: '', now: NOW },
  );
  assert.deepEqual(picked.map(item => item.id), ['oldest', 'newer']);
});

test('the controller rows keep the fields a cleanup needs', () => {
  const value = { items: [{ id: 's1', title: '【私】小明', updatedAt: 5, cwd: 'E:\\work\\qq-bridge', archived: true, running: true }] };
  assert.deepEqual(extractSessions(value), [{ id: 's1', title: '【私】小明', updatedAt: 5, cwd: 'E:\\work\\qq-bridge', archived: true, running: true }]);
});
