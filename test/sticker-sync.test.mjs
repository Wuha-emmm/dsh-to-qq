import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge/runtime.js';
import { StickerStore } from '../src/stickers/store.js';

const PNG_1PX = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
));
const MD5 = '1e54425c18581b3777ecd486236fd4c6';

/** Minimal bridge: the sync path only needs the store, the client, and a directory. */
function makeBridge(config, stickers, stickerDir) {
  const bridge = new Bridge({ store: config, log: () => {}, stickers: undefined });
  bridge.stickers = stickers;
  bridge.stickerDir = stickerDir;
  bridge.client = {
    call: async () => ({ data: [{ emoji_id: 'x', md5: MD5, url: 'https://example.invalid/a.png', desc: '' }] }),
  };
  return bridge;
}

test('syncStickers downloads one preview and describes the sticker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-sync-'));
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(PNG_1PX, { status: 200, headers: { 'content-type': 'image/png' } });
    const stickers = new StickerStore(join(dir, 'stickers.json'), join(dir, 'previews'));
    await stickers.load();
    const bridge = makeBridge({ get: () => ({ stickers: { enabled: true, inPrompt: 24, perHourPerScene: 3, describeBatch: 20 } }) }, stickers, join(dir, 'previews'));

    const result = await bridge.syncStickers({
      describe: async () => ({ desc: '测试表情，用于验证', category: '开心' }),
      batch: 5,
    });
    console.log('DEBUG result:', JSON.stringify(result), 'lastError:', bridge.stickerStats?.lastError);

    assert.equal(result.total, 1);
    assert.equal(result.previewed, 1);
    assert.equal(result.described, 1);
    const sticker = stickers.find(MD5);
    assert.match(sticker.desc, /测试表情/);
    assert.equal(sticker.category, '开心');
    assert.ok(sticker.readAt > 0);
    assert.notEqual(sticker.file, '');
    const files = await readdir(join(dir, 'previews'));
    assert.deepEqual(files, [`${MD5}.png`]);
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncStickers keeps going when the model returns nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-sync-'));
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(PNG_1PX, { status: 200, headers: { 'content-type': 'image/png' } });
    const stickers = new StickerStore(join(dir, 'stickers.json'), join(dir, 'previews'));
    await stickers.load();
    const bridge = makeBridge({ get: () => ({ stickers: { enabled: true } }) }, stickers, join(dir, 'previews'));

    const result = await bridge.syncStickers({ describe: async () => ({ desc: '', category: '' }), batch: 5 });
    assert.equal(result.described, 0);
    assert.equal(stickers.find(MD5).readAt, 0, 'an empty answer leaves it unread');
    assert.match(bridge.stickerStats.lastError, /empty/);
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

