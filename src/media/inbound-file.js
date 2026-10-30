/**
 * Files received over QQ.
 *
 * A `file` segment carries a name and either a URL or a transport-side id. The
 * bridge downloads it into the media directory and hands the absolute path to
 * the model, which is what "收发文件" actually needs.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Refuse absurd payloads rather than filling the disk. */
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Pick the file segments of one message.
 *
 * @param {ReadonlyArray<{ type: string, data?: Record<string, unknown> }>} segments Message segments.
 * @returns {Array<{ type: string, data?: Record<string, unknown> }>} File segments.
 */
export function fileSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.filter(segment => segment?.type === 'file');
}

/**
 * Make a received name safe for the local filesystem.
 *
 * @param {unknown} raw Transport-provided name.
 * @returns {string} A basename with no path separators or traversal.
 */
export function safeFileName(raw) {
  const text = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'file.bin';
  const base = basename(text.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  const trimmed = base.replace(/^\.+/, '').slice(0, 80);
  return trimmed === '' ? 'file.bin' : trimmed;
}

/**
 * Decode a `base64://` payload, or return the raw bytes.
 *
 * @param {string} url URL or `base64://` string.
 * @returns {Promise<Uint8Array>} File bytes.
 */
export async function downloadBytes(url) {
  if (url.startsWith('base64://')) {
    return new Uint8Array(Buffer.from(url.slice('base64://'.length), 'base64'));
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`file download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Download one received file into the media directory.
 *
 * @param {{ call: (action: string, params: object, options?: object) => Promise<any> } | undefined} client OneBot client.
 * @param {{ data?: Record<string, unknown> } | undefined} segment The `file` segment.
 * @param {string} directory Target directory.
 * @param {(line: string) => void} [log] Diagnostic sink.
 * @returns {Promise<string | undefined>} Absolute path, or undefined when unavailable.
 */
export async function fetchInboundFile(client, segment, directory, log = () => {}) {
  if (typeof directory !== 'string' || directory === '') return undefined;
  const data = segment?.data ?? {};
  const name = safeFileName(data.name ?? data.file);
  let url = typeof data.url === 'string' ? data.url : '';

  if (url === '' && typeof data.file === 'string' && data.file !== '' && client !== undefined) {
    try {
      const result = await client.call('get_file', { file_id: data.file, file: data.file }, { timeoutMs: 20_000 });
      const found = result?.data ?? result ?? {};
      if (typeof found.url === 'string') url = found.url;
      else if (typeof found.file === 'string') url = found.file;
      else if (typeof found.base64 === 'string') url = `base64://${found.base64}`;
    } catch (error) {
      log(`file lookup failed for ${name}: ${error?.message ?? error}`);
    }
  }
  if (url === '') return undefined;

  const bytes = await downloadBytes(url);
  if (bytes.length > MAX_BYTES) {
    log(`file ${name} is ${bytes.length} bytes, over the ${MAX_BYTES} limit`);
    return undefined;
  }
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${Date.now()}-${name}`);
  await writeFile(target, bytes);
  return target;
}
