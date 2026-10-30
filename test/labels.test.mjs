import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatGroupLabel, fetchGroupName, sceneLabelFor } from '../src/bridge/labels.js';

test('formatGroupLabel falls back to the number', () => {
  assert.equal(formatGroupLabel(20001, ''), '群 20001');
  assert.equal(formatGroupLabel(20001, undefined), '群 20001');
  assert.equal(formatGroupLabel(20001, '   '), '群 20001');
});

test('formatGroupLabel prefers the name', () => {
  assert.equal(formatGroupLabel(20001, '小鲸鱼们の家'), '群 · 小鲸鱼们の家');
  assert.equal(formatGroupLabel(20001, '  小鲸鱼们の家  '), '群 · 小鲸鱼们の家');
});

test('fetchGroupName reads either response shape', async () => {
  const flat = { call: async () => ({ group_name: '甲群' }) };
  const nested = { call: async () => ({ data: { group_name: '乙群' } }) };
  assert.equal(await fetchGroupName(flat, 1), '甲群');
  assert.equal(await fetchGroupName(nested, 2), '乙群');
});

test('fetchGroupName swallows failures and bad ids', async () => {
  const failing = { call: async () => { throw new Error('boom'); } };
  assert.equal(await fetchGroupName(failing, 3), '');
  assert.equal(await fetchGroupName(undefined, 3), '');
  assert.equal(await fetchGroupName({ call: async () => ({ group_name: 'x' }) }, 0), '');
});

test('sceneLabelFor only labels groups', async () => {
  const client = { call: async () => ({ group_name: '小鲸鱼们の家' }) };
  assert.equal(await sceneLabelFor(client, 'group:20001'), '群 · 小鲸鱼们の家');
  assert.equal(await sceneLabelFor(client, 'dm:10001'), '');
  assert.equal(await sceneLabelFor(client, ''), '');
});

