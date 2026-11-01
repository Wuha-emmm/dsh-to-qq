import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize, shouldShrink, DEFAULT_MAX_EDGE } from '../src/media/shrink.js';

/** Build a minimal PNG header with the given dimensions. */
function png(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** Build a minimal GIF header. */
function gif(width, height) {
  const bytes = new Uint8Array(16);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

test('PNG and GIF sizes are read from the header', () => {
  assert.deepEqual(imageSize(png(2560, 1440)), { width: 2560, height: 1440 });
  assert.deepEqual(imageSize(gif(320, 240)), { width: 320, height: 240 });
  assert.equal(imageSize(new Uint8Array([1, 2, 3])), undefined);
});

test('a large screenshot is worth shrinking, a small one is not', () => {
  assert.equal(shouldShrink(png(2560, 1440)), true);
  assert.equal(shouldShrink(png(1280, 720)), false);
  assert.equal(shouldShrink(png(1920, 1080)), true);
  assert.equal(DEFAULT_MAX_EDGE, 1280);
});

test('an unknown format falls back to the byte heuristic', () => {
  const heavy = new Uint8Array(500 * 1024);
  const light = new Uint8Array(100 * 1024);
  assert.equal(shouldShrink(heavy), true);
  assert.equal(shouldShrink(light), false);
});

test('a WebP canvas size is read as a 24-bit value', () => {
  const bytes = new Uint8Array(40);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  // width - 1 = 1999, height - 1 = 1199, both 24-bit little endian
  const width = 1999;
  const height = 1199;
  bytes[24] = width & 0xff;
  bytes[25] = (width >> 8) & 0xff;
  bytes[26] = (width >> 16) & 0xff;
  bytes[27] = height & 0xff;
  bytes[28] = (height >> 8) & 0xff;
  bytes[29] = (height >> 16) & 0xff;
  assert.deepEqual(imageSize(bytes), { width: 2000, height: 1200 });
});
