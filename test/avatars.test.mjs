import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AvatarCache, avatarUrlFor } from '../src/web/avatars.js';

/** Bytes that pass the JPEG magic-byte check. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

/** A scratch directory that the test removes afterwards. */
const scratch = () => mkdtemp(join(tmpdir(), 'dsh-to-qq-avatars-'));

/** Minimal fetch response shape used by AvatarCache. */
const response = bytes => ({
  ok: true,
  status: 200,
  headers: { get: () => 'image/jpeg' },
  arrayBuffer: async () => bytes.slice().buffer,
});

test('avatarUrlFor maps each scene kind to its qlogo URL', () => {
  assert.equal(avatarUrlFor('group:661526815'), 'https://p.qlogo.cn/gh/661526815/661526815/100');
  assert.equal(avatarUrlFor('dm:1363309111'), 'https://q1.qlogo.cn/g?b=qq&nk=1363309111&s=100');
  assert.equal(avatarUrlFor('group:'), '');
  assert.equal(avatarUrlFor(''), '');
});

test('AvatarCache downloads once and serves the disk copy afterwards', async () => {
  const dir = await scratch();
  try {
    let calls = 0;
    const cache = new AvatarCache(join(dir, 'avatars'), {
      fetch: async () => {
        calls += 1;
        return response(JPEG);
      },
    });
    const first = await cache.get('group:20001');
    assert.equal(first?.type, 'image/jpeg');
    assert.deepEqual([...first.bytes], [...JPEG]);
    const second = await cache.get('group:20001');
    assert.deepEqual([...second.bytes], [...JPEG]);
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AvatarCache dedupes concurrent downloads', async () => {
  const dir = await scratch();
  try {
    let calls = 0;
    const cache = new AvatarCache(join(dir, 'avatars'), {
      fetch: async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        return response(JPEG);
      },
    });
    const [first, second] = await Promise.all([
      cache.get('dm:30001'),
      cache.get('dm:30001'),
    ]);
    assert.deepEqual([...first.bytes], [...JPEG]);
    assert.deepEqual([...second.bytes], [...JPEG]);
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AvatarCache serves the stale copy when a refresh fails', async () => {
  const dir = await scratch();
  try {
    const avatars = join(dir, 'avatars');
    await mkdir(avatars, { recursive: true });
    const file = join(avatars, 'group-40001.img');
    await writeFile(file, JPEG);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(file, old, old);
    const logs = [];
    const cache = new AvatarCache(avatars, {
      fetch: async () => { throw new Error('offline'); },
      log: line => logs.push(line),
    });
    const avatar = await cache.get('group:40001');
    assert.deepEqual([...avatar.bytes], [...JPEG]);
    assert.equal(avatar.type, 'image/jpeg');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /serving the cached copy/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AvatarCache reports a missing portrait without throwing', async () => {
  const dir = await scratch();
  try {
    const cache = new AvatarCache(join(dir, 'avatars'), {
      fetch: async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }),
    });
    assert.equal(await cache.get('group:50001'), undefined);
    assert.equal(await cache.get('not-a-scene'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
