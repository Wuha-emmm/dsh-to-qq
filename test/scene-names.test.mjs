import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SceneNames, cleanDisplayName, parseSceneKey } from '../src/bridge/scene-names.js';

/** A scratch directory that the test removes afterwards. */
const scratch = () => mkdtemp(join(tmpdir(), 'dsh-to-qq-names-'));

test('parseSceneKey accepts group and dm keys only', () => {
  assert.deepEqual(parseSceneKey('group:20001'), { kind: 'group', id: 20001 });
  assert.deepEqual(parseSceneKey('dm:10001'), { kind: 'dm', id: 10001 });
  assert.equal(parseSceneKey('group:'), undefined);
  assert.equal(parseSceneKey('channel:20001'), undefined);
  assert.equal(parseSceneKey('group:020001'), undefined);
  assert.equal(parseSceneKey('group:20001\n'), undefined);
  assert.equal(parseSceneKey(undefined), undefined);
});

test('cleanDisplayName keeps one short safe line', () => {
  assert.equal(cleanDisplayName('  小鲸鱼们の家  '), '小鲸鱼们の家');
  assert.equal(cleanDisplayName('甲\n乙\t丙'), '甲 乙 丙');
  assert.equal(cleanDisplayName('a\u0000b\u202ec'), 'a b c');
  assert.equal(cleanDisplayName(''), '');
  assert.equal(cleanDisplayName(undefined), '');
  assert.equal(cleanDisplayName('x'.repeat(80)).length, 40);
});

test('SceneNames persists names and reloads them', async () => {
  const dir = await scratch();
  try {
    const file = join(dir, 'scene-names.json');
    const store = new SceneNames(file);
    await store.load();
    assert.equal(store.get('group:20001'), '');
    store.seed('group:20001', '甲群');
    store.remember('dm:10001', ' 呜哈\n');
    await store.save();
    assert.equal(store.size, 2);

    const again = new SceneNames(file);
    await again.load();
    assert.equal(again.get('group:20001'), '甲群');
    assert.equal(again.get('dm:10001'), '呜哈');
    assert.equal(again.seed('group:20001', '别的名字'), false);
    assert.equal(again.get('group:20001'), '甲群');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SceneNames ignores a corrupt cache instead of failing', async () => {
  const dir = await scratch();
  try {
    const file = join(dir, 'scene-names.json');
    await writeFile(file, '{not json', 'utf8');
    const store = new SceneNames(file);
    await store.load();
    assert.equal(store.size, 0);
    assert.equal(store.get('group:20001'), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensure resolves group and private names through the transport', async () => {
  const dir = await scratch();
  try {
    const calls = [];
    const client = {
      call: async (action, params) => {
        calls.push({ action, params });
        if (action === 'get_group_info') return { data: { group_name: '乙群' } };
        return { nickname: '呜哈', remark: '' };
      },
    };
    const store = new SceneNames(join(dir, 'scene-names.json'));
    await store.load();
    assert.equal(await store.ensure('group:30001', { client }), true);
    assert.equal(store.get('group:30001'), '乙群');
    assert.equal(await store.ensure('dm:40001', { client }), true);
    assert.equal(store.get('dm:40001'), '呜哈');
    assert.deepEqual(calls.map(call => call.action), ['get_group_info', 'get_stranger_info']);
    assert.equal(calls[1].params.user_id, 40001);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensure prefers a remark over the nickname', async () => {
  const dir = await scratch();
  try {
    const client = { call: async () => ({ remark: '备注名', nickname: '昵称' }) };
    const store = new SceneNames(join(dir, 'scene-names.json'));
    await store.load();
    assert.equal(await store.ensure('dm:40002', { client }), true);
    assert.equal(store.get('dm:40002'), '备注名');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensure falls back to the memory card when the transport has no name', async () => {
  const dir = await scratch();
  try {
    const client = { call: async () => ({ nickname: '' }) };
    const memory = { get: id => (id === 40003 ? { name: '记忆名' } : undefined) };
    const store = new SceneNames(join(dir, 'scene-names.json'));
    await store.load();
    assert.equal(await store.ensure('dm:40003', { client, memory }), true);
    assert.equal(store.get('dm:40003'), '记忆名');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensure dedupes concurrent lookups and backs off after a failure', async () => {
  const dir = await scratch();
  try {
    let calls = 0;
    const failing = {
      call: async () => {
        calls += 1;
        throw new Error('offline');
      },
    };
    const store = new SceneNames(join(dir, 'scene-names.json'));
    await store.load();
    const [first, second] = await Promise.all([
      store.ensure('group:50001', { client: failing }),
      store.ensure('group:50001', { client: failing }),
    ]);
    assert.equal(first, false);
    assert.equal(second, false);
    assert.equal(calls, 1);
    assert.equal(await store.ensure('group:50001', { client: failing }), false);
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
