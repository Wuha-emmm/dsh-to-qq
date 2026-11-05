/**
 * Outbound file uploads for OneBot.
 *
 * SnowLuma (and most OneBot implementations) do not read a Windows path that
 * the bridge happens to know: the upload action wants bytes or a URI. Handing
 * over `E:\...` looked like it worked — the call returned without throwing —
 * and the file simply never arrived. Read the bytes and send them inline, and
 * check the returned status so a refusal is reported instead of swallowed.
 *
 * @module media/outbound-file
 */

import { readFile, stat } from 'node:fs/promises';

/** Anything larger is passed as a path and left to the host to stream. */
export const MAX_INLINE_BYTES = 40 * 1024 * 1024;

/**
 * Turn a local path into something an upload action accepts.
 *
 * @param {string} path Absolute path on this machine.
 * @returns {Promise<string>} `base64://` payload, or the original path when huge.
 */
export async function toUploadSource(path) {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || info.isFile() !== true) throw new Error(`file not found: ${path}`);
  if (info.size === 0) throw new Error(`file is empty: ${path}`);
  if (info.size > MAX_INLINE_BYTES) return path;
  const bytes = await readFile(path);
  return `base64://${bytes.toString('base64')}`;
}

/**
 * Throw when an action reported failure through its envelope.
 *
 * OneBot answers with `{ status, retcode, message }`; a refused upload is not a
 * transport error, so the call resolves and the bridge would claim success.
 *
 * @param {any} result Action result.
 * @param {string} action Action name, for the error text.
 * @returns {void}
 */
export function assertOneBotOk(result, action) {
  if (result === undefined || result === null) return;
  const status = String(result.status ?? result?.data?.status ?? '');
  const retcode = Number(result.retcode ?? result?.data?.retcode ?? 0) || 0;
  if (status === 'failed' || retcode !== 0) {
    const detail = String(result.message ?? result.wording ?? result?.data?.message ?? '').slice(0, 160);
    throw new Error(`${action} failed: ${status === '' ? 'error' : status} retcode=${retcode}${detail === '' ? '' : ` (${detail})`}`);
  }
}
