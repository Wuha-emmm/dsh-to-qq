/**
 * Re-encode a screenshot as JPEG before it is uploaded to QQ.
 *
 * A 1440p PNG is 3–7 MB, and the QQ upload is the slow part of sending a picture
 * (measured: 5.3s for a 6.5 MB file). The same frame at JPEG quality 88 is a few
 * hundred KB. The local PNG stays untouched — the model reads that one when the
 * detail matters, so viewing speed and reading accuracy stop competing.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../render/encode-jpeg.ps1', import.meta.url));

/** Files above this size are worth re-encoding. */
export const UPLOAD_THRESHOLD_BYTES = 800 * 1024;

/** JPEG quality used for uploads; high enough that UI text survives. */
export const UPLOAD_QUALITY = 88;

/**
 * Whether a file should be re-encoded before upload.
 *
 * @param {{ size: number, name: string }} info File facts.
 * @returns {boolean} True when the upload would benefit.
 */
export function shouldCompress(info) {
  const size = Number(info?.size) || 0;
  const name = String(info?.name ?? '').toLowerCase();
  if (size <= UPLOAD_THRESHOLD_BYTES) return false;
  return /\.(png|bmp|webp)$/.test(name);
}

/**
 * Run the JPEG encoder.
 *
 * @param {string} source Source image.
 * @param {string} target Output path.
 * @param {{ quality?: number, maxEdge?: number, timeoutMs?: number }} [options] Wiring.
 * @returns {Promise<void>} Resolves when written.
 */
async function encode(source, target, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      '-Source', source,
      '-Target', target,
      '-Quality', String(options.quality ?? UPLOAD_QUALITY),
      '-MaxEdge', String(options.maxEdge ?? 0),
    ], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('jpeg encode timed out'));
    }, options.timeoutMs ?? 20_000);
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`jpeg encode exited ${code}: ${stderr.trim().slice(0, 160)}`));
    });
  });
}

/**
 * Produce a JPEG copy for upload, or the original when that would not help.
 *
 * @param {string} path Absolute image path.
 * @param {{ size?: number, quality?: number, maxEdge?: number, log?: (line: string) => void }} [options] Wiring.
 * @returns {Promise<{ path: string, converted: boolean, bytes: number }>} What to upload.
 */
export async function compressForUpload(path, options = {}) {
  const source = String(path ?? '').trim();
  const name = source.split(/[\\/]/).pop() ?? '';
  const size = Number(options.size) || 0;
  if (source === '' || !shouldCompress({ size, name })) return { path: source, converted: false, bytes: size };
  const directory = await mkdtemp(join(tmpdir(), 'dsh-to-qq-upload-'));
  const target = join(directory, `${name.replace(/\.[^.]+$/, '')}.jpg`);
  try {
    await encode(source, target, options);
    const bytes = (await readFile(target)).length;
    options.log?.(`upload copy ${Math.round(size / 1024)}KB → ${Math.round(bytes / 1024)}KB (jpeg q${options.quality ?? UPLOAD_QUALITY})`);
    return { path: target, converted: true, bytes };
  } catch (error) {
    options.log?.(`upload encode failed, sending the original: ${error?.message ?? error}`);
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    return { path: source, converted: false, bytes: size };
  }
}

/** Quality used for rendered cards: text stays crisp, bytes drop by ~80%. */
export const CARD_QUALITY = 92;

/**
 * Re-encode a `base64://` image payload as JPEG for sending.
 *
 * Cards are rendered as PNG (758 KB – 1.05 MB) and travel as base64, so the QQ
 * upload is the slow part. Text on a card is large; quality 92 keeps it crisp.
 *
 * @param {string} payload `base64://` payload from a renderer.
 * @param {{ quality?: number, log?: (line: string) => void }} [options] Wiring.
 * @returns {Promise<string>} JPEG payload, or the input when encoding did not help.
 */
export async function compressPayload(payload, options = {}) {
  const raw = String(payload ?? '');
  const encoded = raw.startsWith('base64://') ? raw.slice('base64://'.length) : raw;
  if (encoded === '') return payload;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) return payload;
  const directory = await mkdtemp(join(tmpdir(), 'dsh-to-qq-card-'));
  const source = join(directory, 'card.png');
  const target = join(directory, 'card.jpg');
  try {
    await writeFile(source, bytes);
    await encode(source, target, { quality: options.quality ?? CARD_QUALITY });
    const jpeg = await readFile(target);
    if (jpeg.length >= bytes.length) return payload;
    options.log?.(`card payload ${Math.round(bytes.length / 1024)}KB → ${Math.round(jpeg.length / 1024)}KB`);
    return `base64://${jpeg.toString('base64')}`;
  } catch (error) {
    options.log?.(`card encode failed, sending png: ${error?.message ?? error}`);
    return payload;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
