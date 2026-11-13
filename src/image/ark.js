/**
 * 火山方舟 (Volcengine Ark) image generation — the provider behind `/画`.
 *
 * Ark speaks a small JSON API (`POST /images/generations`): a bearer key, a model
 * id such as `doubao-seedream-5-0-flash-260915`, and either a text prompt or a
 * prompt plus an input image (图生图). The answer carries a short-lived signed
 * URL, so the caller gets bytes, not a link that dies in a day.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/** Ark's public endpoint; a private deployment can override it. */
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/** Image types Ark accepts as an 图生图 input, by file extension. */
const MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
]);

/**
 * The MIME type of a picture format Ark reports in `output_format`.
 *
 * @param {unknown} format `png`, `jpeg`, `webp`, …
 * @returns {string} A MIME type.
 */
function mimeOf(format) {
  const value = String(format ?? '').toLowerCase();
  if (value === 'png') return 'image/png';
  if (value === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Generate one image.
 *
 * @param {object} options What to draw and with which account.
 * @param {string} options.apiKey Ark API key.
 * @param {string} [options.baseUrl] API root; defaults to the public endpoint.
 * @param {string} options.model Model id, e.g. `doubao-seedream-5-0-flash-260915`.
 * @param {string} options.prompt What the picture should show.
 * @param {string} [options.size] `1024x1024`, `1536x1024`, `2K`, … Ark's own sizes.
 * @param {string} [options.imagePath] Local picture to edit (图生图) instead of drawing from scratch.
 * @param {boolean} [options.watermark] Ask Ark to stamp its watermark; off by default.
 * @param {number} [options.timeoutMs] Generation timeout.
 * @returns {Promise<{ bytes: Buffer, mime: string, usage: any }>} The picture.
 */
export async function generateImage(options) {
  const apiKey = String(options?.apiKey ?? '').trim();
  if (apiKey === '') {
    throw new Error('图还没配 key：设置里填 image.apiKey，再发 /画。');
  }
  const model = String(options?.model ?? '').trim();
  if (model === '') throw new Error('图还没配模型名（image.model）。');
  const prompt = String(options?.prompt ?? '').trim();
  if (prompt === '') throw new Error('要画什么？');

  const root = String(options?.baseUrl ?? '').trim() === ''
    ? DEFAULT_BASE_URL
    : String(options.baseUrl).trim().replace(/\/+$/, '');

  /** @type {Record<string, unknown>} */
  const body = {
    model,
    prompt,
    size: String(options?.size ?? '').trim() || '1024x1024',
    response_format: 'url',
    watermark: options?.watermark === true,
    // Seedream may answer with a group of linked pictures; one is what we send.
    sequential_image_generation: 'disabled',
  };
  if (typeof options?.imagePath === 'string' && options.imagePath !== '') {
    const bytes = await readFile(options.imagePath);
    const mime = MIME_BY_EXTENSION.get(extname(options.imagePath).toLowerCase()) ?? 'image/jpeg';
    body.image = `data:${mime};base64,${bytes.toString('base64')}`;
  }

  const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 180_000;
  let response;
  try {
    response = await fetch(`${root}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? `超时（${Math.round(timeoutMs / 1000)} 秒）` : String(error?.message ?? error);
    throw new Error(`出图请求没发出去：${reason}`);
  }

  const text = await response.text();
  /** @type {any} */
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`出图接口回的看不懂：${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.message ?? text.slice(0, 160);
    throw new Error(`出图失败（${response.status}）：${String(detail).slice(0, 200)}`);
  }

  const first = payload?.data?.[0];
  if (first === null || first === undefined) throw new Error('出图接口没给图。');
  if (typeof first.b64_json === 'string' && first.b64_json !== '') {
    return { bytes: Buffer.from(first.b64_json, 'base64'), mime: mimeOf(first.output_format), usage: payload.usage };
  }
  const url = String(first.url ?? '');
  if (!/^https?:\/\//.test(url)) throw new Error('出图接口没给能下载的地址。');
  const download = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!download.ok) throw new Error(`下载生成的图失败（${download.status}）。`);
  return {
    bytes: Buffer.from(await download.arrayBuffer()),
    mime: mimeOf(first.output_format),
    usage: payload.usage,
  };
}
