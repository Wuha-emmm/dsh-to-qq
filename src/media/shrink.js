/**
 * Shrinking an image before the model looks at it.
 *
 * A 2560×1440 screenshot is roughly four times the prompt cost of a 1280-wide one,
 * and the QQ sessions spent most of their context on exactly those screenshots. The
 * image is resized with the same GDI+ helper the sticker previews use, and the model
 * reads the smaller copy — the original stays untouched for the case where small text
 * matters.
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runResize } from './thumbnail.js';

/** Longest edge kept by default; enough for UI text at normal zoom. */
export const DEFAULT_MAX_EDGE = 1280;

/** Byte size above which a picture is worth shrinking even without its size. */
const HEAVY_BYTES = 400 * 1024;

/**
 * Read the pixel size from the header of a PNG, JPEG, GIF or WebP file.
 *
 * @param {Uint8Array} bytes Image bytes.
 * @returns {{ width: number, height: number } | undefined} Size, or undefined when unknown.
 */
export function imageSize(bytes) {
  if (bytes === undefined || bytes.length < 10) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: IHDR at byte 16.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    if (bytes.length < 24) return undefined;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // GIF: logical screen descriptor at byte 6.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  // WEBP (VP8X / VP8 / VP8L): dimensions live in the first chunk.
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    const format = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (format === 'VP8X') return { width: 1 + view.getUint32(24, true), height: 1 + view.getUint32(27, true) };
    if (format === 'VP8 ') {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    return undefined;
  }
  // JPEG: walk the markers until a start-of-frame segment.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      const length = view.getUint16(offset + 2);
      if (length <= 0) break;
      offset += 2 + length;
    }
  }
  return undefined;
}

/**
 * Whether a picture is big enough to be worth shrinking.
 *
 * @param {Uint8Array} bytes Image bytes.
 * @param {number} [maxEdge] Longest edge allowed.
 * @returns {boolean} True when it should be shrunk.
 */
export function shouldShrink(bytes, maxEdge = DEFAULT_MAX_EDGE) {
  const size = imageSize(bytes);
  if (size !== undefined) return Math.max(size.width, size.height) > maxEdge;
  return bytes !== undefined && bytes.length > HEAVY_BYTES;
}

/**
 * Shrink a file on disk and return the smaller copy's path.
 *
 * @param {string} input Absolute source path.
 * @param {{ maxEdge?: number, log?: (line: string) => void }} [options] Wiring.
 * @returns {Promise<{ path: string, bytes: number, shrunk: boolean, width?: number, height?: number }>} Result.
 */
export async function shrinkFile(input, options = {}) {
  const maxEdge = Math.max(320, Math.min(2048, Number(options.maxEdge) || DEFAULT_MAX_EDGE));
  const source = String(input ?? '').trim();
  if (source === '') throw new Error('path is empty');
  const info = await stat(source).catch(() => undefined);
  if (info === undefined || !info.isFile()) throw new Error(`找不到图片：${source}`);
  const bytes = new Uint8Array(await readFile(source));
  const size = imageSize(bytes);
  if (!shouldShrink(bytes, maxEdge)) {
    return { path: source, bytes: info.size, shrunk: false, ...(size ?? {}) };
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-to-qq-shrink-'));
  const output = join(directory, `small${extname(source) === '' ? '.png' : extname(source)}`);
  try {
    await runResize(source, output, maxEdge, 20_000);
    const shrunkBytes = await stat(output);
    options.log?.(`shrunk ${source} ${Math.round(info.size / 1024)}KB → ${Math.round(shrunkBytes.size / 1024)}KB`);
    return {
      path: output,
      bytes: shrunkBytes.size,
      shrunk: true,
      ...(imageSize(new Uint8Array(await readFile(output))) ?? {}),
    };
  } catch (error) {
    options.log?.(`shrink failed, keeping the original: ${error?.message ?? error}`);
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    return { path: source, bytes: info.size, shrunk: false, ...(size ?? {}) };
  }
}

/**
 * Shrink image bytes for prompt admission.
 *
 * @param {Uint8Array} bytes Downloaded bytes.
 * @param {string} mediaType Source media type.
 * @param {{ maxEdge?: number, log?: (line: string) => void }} [options] Wiring.
 * @returns {Promise<Uint8Array>} Smaller bytes, or the original when not worth it.
 */
export async function shrinkBytes(bytes, mediaType, options = {}) {
  if (!shouldShrink(bytes, options.maxEdge)) return bytes;
  const directory = await mkdtemp(join(tmpdir(), 'dsh-to-qq-inbound-'));
  const source = join(directory, mediaType === 'image/jpeg' ? 'source.jpg' : 'source.png');
  const output = join(directory, 'small.png');
  try {
    await writeFile(source, bytes);
    await runResize(source, output, Math.max(320, Math.min(2048, Number(options.maxEdge) || DEFAULT_MAX_EDGE)), 20_000);
    const shrunk = new Uint8Array(await readFile(output));
    options.log?.(`inbound image ${Math.round(bytes.length / 1024)}KB → ${Math.round(shrunk.length / 1024)}KB`);
    return shrunk;
  } catch (error) {
    options.log?.(`inbound shrink failed, keeping the original: ${error?.message ?? error}`);
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
