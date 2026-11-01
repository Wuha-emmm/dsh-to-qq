/**
 * Inbound QQ images.
 *
 * OneBot gives an image segment a URL; the DSH attachment service owns durable
 * image storage, so the bridge downloads the bytes and hands them over before a
 * prompt can reference the picture.
 */

/** Media types the attachment service accepts. */
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

import { composeGifSheet } from './gif.js';
import { shrinkBytes } from './shrink.js';

/** How many images one prompt may carry when the host advertises no policy. */
/** Refuse oversized downloads: a huge image would be base64-inlined into the prompt. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_IMAGES = 4;

/**
 * Pick the image segments of one message.
 *
 * @param {ReadonlyArray<{ type: string, data?: Record<string, unknown> }>} segments Message segments.
 * @param {number} [limit] Maximum images to keep.
 * @returns {Array<{ type: string, data?: Record<string, unknown> }>} Image segments, in message order.
 */
export function imageSegments(segments, limit = DEFAULT_MAX_IMAGES) {
  if (!Array.isArray(segments)) return [];
  return segments.filter(segment => segment?.type === 'image').slice(0, Math.max(0, limit));
}

/**
 * Sniff an image media type from magic bytes, falling back to the header.
 *
 * @param {Uint8Array} bytes Image bytes.
 * @param {string | null} [header] `content-type` header value.
 * @returns {'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'} The media type.
 */
export function detectMediaType(bytes, header) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  const declared = String(header ?? '').split(';')[0].trim().toLowerCase();
  if (ACCEPTED.has(declared)) return declared;
  return 'image/png';
}

/**
 * Whether a segment looks like a reaction image rather than a real picture.
 *
 * @param {{ data?: Record<string, unknown> }} segment Image segment.
 * @returns {boolean} True for stickers and memes.
 */
export function looksLikeSticker(segment) {
  const summary = String(segment?.data?.summary ?? '');
  return summary.includes('表情') || summary.includes('emoji') || summary.includes('动画表情');
}

/**
 * Download one image segment.
 *
 * @param {{ data?: Record<string, unknown> }} segment Image segment.
 * @param {{ timeoutMs?: number }} [options] Download options.
 * @returns {Promise<{ data: Uint8Array, mediaType: string, name?: string }>} The bytes.
 */
export async function downloadImage(segment, options = {}) {
  const url = segment?.data?.url;
  if (typeof url !== 'string' || url === '') throw new Error('image segment carries no url');
  const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
  if (!response.ok) throw new Error(`image download failed: HTTP ${response.status}`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`image is ${buffer.length} bytes, over the ${MAX_IMAGE_BYTES} limit`);
  if (buffer.length === 0) throw new Error('image download returned no bytes');
  return {
    data: buffer,
    mediaType: detectMediaType(buffer, response.headers.get('content-type')),
    name: typeof segment.data?.file === 'string' ? segment.data.file.slice(-64) : undefined,
  };
}

/**
 * Download every image of one message, shaped for prompt admission.
 *
 * The Host wants encoded bytes here, not a stored reference: it validates and
 * stores the images itself, then swaps each part for its durable reference.
 * Animated images are replaced by a contact sheet so motion survives the trip.
 *
 * @param {ReadonlyArray<{ type: string, data?: Record<string, unknown> }>} segments Message segments.
 * @param {(line: string) => void} log Diagnostic sink.
 * @param {number} [limit] Maximum images to keep.
 * @returns {Promise<{ parts: Array<{ type: 'image', data: string, mediaType: string, name?: string }>, originals: Array<{ data: Uint8Array, mediaType: string }> }>} Prompt parts plus the untransformed bytes.
 */
export async function promptImageParts(segments, log, limit = DEFAULT_MAX_IMAGES) {
  /** @type {Array<{ type: 'image', data: string, mediaType: string, name?: string }>} */
  const parts = [];
  /** @type {Array<{ data: Uint8Array, mediaType: string }>} */
  const originals = [];
  /** @type {Array<{ frames: number, total: number }>} */
  const sheets = [];
  for (const segment of imageSegments(segments, limit)) {
    try {
      const image = await downloadImage(segment);
      originals.push({ data: image.data, mediaType: image.mediaType });
      let shaped = image;
      if (image.mediaType === 'image/gif') {
        const sheet = await composeGifSheet(image.data, log);
        if (sheet !== undefined) {
          shaped = { data: sheet.data, mediaType: 'image/png', name: image.name };
          sheets.push({ frames: sheet.frames, total: sheet.total });
        }
      }
      // A phone screenshot costs four times the prompt of a 1280-wide copy.
      const smaller = await shrinkBytes(shaped.data, shaped.mediaType, { log });
      parts.push({
        type: 'image',
        data: Buffer.from(smaller).toString('base64'),
        mediaType: smaller === shaped.data ? shaped.mediaType : 'image/png',
        ...(image.name === undefined ? {} : { name: image.name }),
      });
    } catch (error) {
      log(`image skipped: ${error?.message ?? error}`);
    }
  }
  return { parts, originals, sheets };
}

/**
 * Write one image into the media archive.
 *
 * @param {{ data: Uint8Array, mediaType: string }} image Downloaded image.
 * @param {string} directory Target directory.
 * @returns {Promise<string>} Absolute path of the written file.
 */
export async function persistImage(image, directory) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const extension = image.mediaType.replace('image/', '').replace('jpeg', 'jpg');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${stamp}-${Math.random().toString(36).slice(2, 8)}.${extension}`);
  await writeFile(target, image.data);
  return target;
}
