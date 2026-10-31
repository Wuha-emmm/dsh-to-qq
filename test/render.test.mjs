import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTextImage, renderTextImageBase64 } from '../src/render/text-image.js';
import { cardTitle } from '../src/render/memory-card.js';

const windows = process.platform === 'win32';

test('renders a PNG with Chinese text', { skip: !windows }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-render-'));
  try {
    const out = join(dir, 'card.png');
    await renderTextImage({
      text: '这是一段很长的回复。\n第二行带 English 和 12345，还有标点，。！？',
      outPath: out,
      style: 'light',
      width: 640,
      fontSize: 20,
    });
    const info = await stat(out);
    assert.ok(info.size > 2000, `png too small: ${info.size}`);
    const header = await readFile(out);
    assert.equal(header.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'must be a real PNG');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns a base64 payload for OneBot image segments', { skip: !windows }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-render-'));
  try {
    const payload = await renderTextImageBase64({
      text: '短文本',
      outPath: join(dir, 'x.png'),
      style: 'bubble',
      width: 480,
      fontSize: 18,
    });
    assert.match(payload, /^base64:\/\/[A-Za-z0-9+/=]+$/);
    assert.ok(payload.length > 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the card title carries the name and the QQ number', () => {
  assert.equal(cardTitle('小明', 123456789), '【小明】QQ 123456789');
  assert.equal(cardTitle('  老白  ', 20002), '【老白】QQ 20002');
  assert.equal(cardTitle('', 20002), 'QQ 20002');
  assert.equal(cardTitle(undefined, 20002), 'QQ 20002');
});
