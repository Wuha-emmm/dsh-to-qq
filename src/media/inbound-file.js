/**
 * Files received over QQ.
 *
 * A `file` segment carries a name and either a URL or a transport-side id. The
 * bridge downloads it into the media directory and hands the absolute path to
 * the model, which is what "收发文件" actually needs.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Refuse absurd payloads rather than filling the disk. 200MB covers安装包/压缩包 transfers. */
const MAX_BYTES = 200 * 1024 * 1024;

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
 * @param {{ groupId?: number | string }} [context] Where the file arrived (a group id switches to the group API).
 * @returns {Promise<string | undefined>} Absolute path, or undefined when unavailable.
 */
export async function fetchInboundFile(client, segment, directory, log = () => {}, context = {}) {
  if (typeof directory !== 'string' || directory === '') return undefined;
  const data = segment?.data ?? {};
  const name = safeFileName(data.name ?? data.file ?? data.file_id);
  const directUrl = typeof data.url === 'string' ? data.url : '';
  const fileId = typeof data.file_id === 'string' && data.file_id !== ''
    ? data.file_id
    : (typeof data.id === 'string' ? data.id : '');

  /**
   * Ask the transport for a fresh link. `get_file` only resolves cached images
   * and voices, so ordinary QQ files must go through the scoped url actions.
   */
  const resolveUrl = async () => {
    if (client === undefined) return '';
    if (fileId !== '') {
      const groupId = Number(context?.groupId);
      try {
        const params = Number.isFinite(groupId) && groupId !== 0
          ? { group_id: groupId, file_id: fileId }
          : { user_id: Number(context?.userId) || 0, file_id: fileId };
        const action = Number.isFinite(groupId) && groupId !== 0 ? 'get_group_file_url' : 'get_private_file_url';
        const result = await client.call(action, params, { timeoutMs: 20_000 });
        const found = result?.data ?? result ?? {};
        if (typeof found.url === 'string' && found.url !== '') return found.url;
        if (typeof found.file === 'string' && found.file !== '') return found.file;
        log(`file url lookup returned no url for ${name}: ${JSON.stringify(found).slice(0, 200)}`);
      } catch (error) {
        log(`file url lookup failed for ${name}: ${error?.message ?? error}`);
      }
    }
    // Last resort: the legacy cache lookup, which still helps for voice-like files.
    const lookup = fileId !== '' ? fileId : (typeof data.file === 'string' ? data.file : '');
    if (lookup !== '') {
      try {
        const result = await client.call('get_file', { file_id: lookup, file: lookup }, { timeoutMs: 20_000 });
        const found = result?.data ?? result ?? {};
        if (typeof found.url === 'string' && found.url !== '') return found.url;
        if (typeof found.base64 === 'string') return `base64://${found.base64}`;
      } catch (error) {
        log(`file lookup failed for ${name}: ${error?.message ?? error}`);
      }
    }
    return '';
  };

  const candidates = [];
  if (directUrl !== '') candidates.push(directUrl);
  let bytes;
  for (const url of candidates) {
    try {
      bytes = await downloadBytes(url);
      break;
    } catch (error) {
      log(`direct file download failed for ${name}: ${error?.message ?? error}`);
    }
  }
  if (bytes === undefined) {
    const url = await resolveUrl();
    if (url === '') return undefined;
    bytes = await downloadBytes(url);
  }

  if (bytes.length > MAX_BYTES) {
    log(`file ${name} is ${bytes.length} bytes, over the ${MAX_BYTES} limit`);
    return undefined;
  }
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${Date.now()}-${name}`);
  await writeFile(target, bytes);
  return target;
}
