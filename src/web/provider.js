/**
 * A `web.fetch` provider that behaves like a browser.
 *
 * DSH owns `web_fetch`; a plugin can only contribute the transport behind it. This
 * provider sends browser headers, resolves short links, and attaches the signed-in
 * cookie for the sites the 登录 tab knows about. It is selected through
 * `web.fetchProvider: browser-fetch` in the profile patch.
 */

import { checkUrl, resolveShortLink, bvidOf, bilibiliVideo } from '../media/page.js';

/** A current desktop Chrome identifier. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Cap on the body kept from one page. */
const MAX_BYTES = 512 * 1024;

/**
 * Create the fetch provider.
 *
 * @param {{ cookieFor?: (url: string) => string, log?: (line: string) => void }} [options] Wiring.
 * @returns {{ id: string, available: () => boolean, fetch: (request: { url: string }, signal?: AbortSignal) => Promise<any> }} Provider.
 */
export function createFetchProvider(options = {}) {
  const log = options.log ?? (() => {});
  const cookieFor = typeof options.cookieFor === 'function' ? options.cookieFor : () => '';

  return {
    id: 'browser-fetch',
    available: () => true,
    /**
     * Retrieve one URL.
     *
     * @param {{ url: string }} request What to fetch.
     * @param {AbortSignal} [signal] Cancellation.
     * @returns {Promise<{ url: string, statusCode: number, body: { kind: 'html' | 'text', content: string }, truncated: boolean }>} Result.
     */
    async fetch(request, signal) {
      const checked = checkUrl(request?.url);
      if (checked.error !== undefined) throw new Error(checked.error);
      const resolved = await resolveShortLink(checked.url);
      const cookie = cookieFor(resolved);

      // A video page renders client-side; the public API is the readable form.
      const bvid = bvidOf(resolved);
      if (bvid !== '') {
        const video = await bilibiliVideo(bvid, fetch, cookie);
        if (video !== undefined) {
          const lines = [`B站视频：${video.title}`];
          if (video.owner !== '') lines.push(`UP主：${video.owner}`);
          if (video.description !== '') lines.push(`简介：${video.description.slice(0, 400)}`);
          if (video.comments > 0) lines.push(`评论数：${video.comments}`);
          lines.push(`链接：${resolved}`);
          return {
            url: resolved,
            statusCode: 200,
            body: { kind: 'text', content: lines.join('\n') },
            truncated: false,
          };
        }
      }

      const response = await fetch(resolved, {
        redirect: 'follow',
        headers: {
          'user-agent': USER_AGENT,
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          referer: new URL(resolved).origin,
          ...(cookie === '' ? {} : { cookie }),
        },
        signal: signal ?? AbortSignal.timeout(20_000),
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      const type = String(response.headers.get('content-type') ?? '');
      const text = buffer.subarray(0, MAX_BYTES).toString('utf8');
      log(`web fetch ${resolved} → ${response.status} (${buffer.length} bytes)`);
      return {
        url: resolved,
        statusCode: response.status,
        body: { kind: type.includes('text/html') || type === '' ? 'html' : 'text', content: text },
        truncated: buffer.length > MAX_BYTES,
      };
    },
  };
}
