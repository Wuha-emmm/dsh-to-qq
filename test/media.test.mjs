import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSegments, detectMediaType, looksLikeSticker, promptImageParts } from '../src/media/inbound.js';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

test('detectMediaType trusts magic bytes over the header', () => {
  assert.equal(detectMediaType(png, 'image/jpeg'), 'image/png');
  assert.equal(detectMediaType(jpeg, 'image/png'), 'image/jpeg');
  assert.equal(detectMediaType(gif), 'image/gif');
  assert.equal(detectMediaType(webp), 'image/webp');
});

test('detectMediaType falls back to the declared type, then png', () => {
  const unknown = Uint8Array.from([0x00, 0x01, 0x02]);
  assert.equal(detectMediaType(unknown, 'image/webp; charset=binary'), 'image/webp');
  assert.equal(detectMediaType(unknown, 'application/octet-stream'), 'image/png');
  assert.equal(detectMediaType(unknown, null), 'image/png');
});

test('imageSegments keeps order and respects the limit', () => {
  const segments = [
    { type: 'text', data: { text: 'hi' } },
    { type: 'image', data: { url: 'a' } },
    { type: 'face', data: {} },
    { type: 'image', data: { url: 'b' } },
    { type: 'image', data: { url: 'c' } },
  ];
  assert.deepEqual(imageSegments(segments).map(item => item.data.url), ['a', 'b', 'c']);
  assert.deepEqual(imageSegments(segments, 2).map(item => item.data.url), ['a', 'b']);
  assert.deepEqual(imageSegments(segments, 0), []);
  assert.deepEqual(imageSegments(undefined), []);
});

test('looksLikeSticker reads the QQ summary', () => {
  assert.equal(looksLikeSticker({ data: { summary: '[动画表情]' } }), true);
  assert.equal(looksLikeSticker({ data: { summary: '表情' } }), true);
  assert.equal(looksLikeSticker({ data: { summary: '' } }), false);
  assert.equal(looksLikeSticker({}), false);
});

test('promptImageParts hands the Host base64 bytes, not references', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  try {
    const { parts, originals } = await promptImageParts([{ type: 'image', data: { url: 'http://x/a.png', file: 'a.png' } }], () => {});
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'image');
    assert.equal(parts[0].mediaType, 'image/png');
    assert.equal(parts[0].name, 'a.png');
    assert.equal(parts[0].data, Buffer.from(png).toString('base64'));
    assert.equal('attachment' in parts[0], false, 'no durable reference is passed through');
    assert.equal(originals.length, 1, 'the raw bytes stay available for the archive');
  } finally {
    globalThis.fetch = original;
  }
});

test('promptImageParts survives a failing download', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 502 });
  try {
    const lines = [];
    const { parts } = await promptImageParts([{ type: 'image', data: { url: 'http://x/a.png' } }], line => lines.push(line));
    assert.deepEqual(parts, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /HTTP 502/);
  } finally {
    globalThis.fetch = original;
  }
});
