/**
 * Fetch a web page the way a browser would.
 *
 * DSH's own `web_fetch` sends a bare request, which Bilibili (and several other
 * sites) answer with a block page, and a short link such as `b23.tv/xxxx` only
 * redirects to a home page. This module adds the two things those sites expect:
 * browser headers, and short-link resolution before the metadata read.
 */

/** A current desktop Chrome identifier; bare fetch is what gets blocked. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Hosts whose links are just redirects to the real page. */
const SHORT_HOSTS = new Set(['b23.tv', 'bili2233.cn', 't.cn', 'youtu.be', 'v.douyin.com', 'xhslink.com']);

/** Cap on how much HTML is read, so one page cannot eat the memory budget. */
const MAX_BYTES = 512 * 1024;

/**
 * Whether a host is on the local machine or a private network.
 *
 * A group member must never be able to point the fetcher at the OneBot port,
 * the panel, or a LAN device, so this is checked before every request.
 *
 * @param {string} hostname Host from `new URL`.
 * @returns {boolean} True when the request must be refused.
 */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe80:/.test(host)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 !== null) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

/**
 * Validate and normalize a URL for fetching.
 *
 * @param {string} raw Candidate URL.
 * @returns {{ url: string } | { error: string }} Normalized URL or a reason.
 */
export function checkUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw ?? '').trim());
  } catch {
    return { error: '不是合法的 URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: '只支持 http/https' };
  if (isPrivateHost(parsed.hostname)) return { error: '拒绝访问本机或内网地址' };
  return { url: parsed.toString() };
}

/**
 * Read a `<meta>` value by property or name.
 *
 * @param {string} html Page HTML.
 * @param {string} key meta key, such as `og:title`.
 * @returns {string} Trimmed content, or ''.
 */
function meta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']{1,500})["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']{1,500})["'][^>]*(?:property|name)=["']${escaped}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match !== null) return decodeEntities(match[1]).trim();
  }
  return '';
}

/**
 * Undo the few entities that appear in titles.
 *
 * @param {string} text Raw text.
 * @returns {string} Decoded text.
 */
function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

/**
 * Read the title and description out of a page.
 *
 * @param {string} html Page HTML.
 * @returns {{ title: string, description: string, image: string }} Fields.
 */
export function readPageMeta(html) {
  const title = meta(html, 'og:title') || meta(html, 'twitter:title')
    || decodeEntities(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html)?.[1] ?? '').trim();
  const description = meta(html, 'og:description') || meta(html, 'twitter:description')
    || meta(html, 'description');
  const image = meta(html, 'og:image') || meta(html, 'twitter:image');
  return { title: title.slice(0, 200), description: description.slice(0, 400), image: image.slice(0, 400) };
}

/**
 * Follow the redirects a short link hides.
 *
 * @param {string} url Starting URL.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<string>} Final URL, or the input when resolution failed.
 */
export async function resolveShortLink(url, fetchImpl = fetch) {
  const host = new URL(url).hostname.toLowerCase();
  if (!SHORT_HOSTS.has(host)) return url;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(8000),
    });
    return response.url === '' ? url : response.url;
  } catch {
    return url;
  }
}

/**
 * Read a Bilibili video through its public API.
 *
 * The HTML page renders client-side, so the API is the only reliable source of
 * title, description and owner.
 *
 * @param {string} bvid Video id such as `BV1xx411c7mD`.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<{ title: string, description: string, owner: string, duration: number } | undefined>} Video facts.
 */
export async function bilibiliVideo(bvid, fetchImpl = fetch, cookie = '') {
  try {
    const response = await fetchImpl(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
      headers: {
        'user-agent': USER_AGENT,
        referer: 'https://www.bilibili.com/',
        accept: 'application/json',
        ...(cookie === '' ? {} : { cookie }),
      },
      signal: AbortSignal.timeout(8000),
    });
    const payload = await response.json();
    if (Number(payload?.code) !== 0 || payload?.data === undefined) return undefined;
    const data = payload.data;
    return {
      title: String(data.title ?? ''),
      description: String(data.desc ?? ''),
      owner: String(data.owner?.name ?? ''),
      duration: Number(data.duration) || 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Pull a BV id out of a Bilibili URL.
 *
 * @param {string} url Page URL.
 * @returns {string} The id, or ''.
 */
export function bvidOf(url) {
  return /\/(BV[0-9A-Za-z]{8,12})/.exec(url)?.[1] ?? '';
}

/**
 * Fetch one page and describe it.
 *
 * @param {string} rawUrl URL the model asked for.
 * @param {{ fetchImpl?: typeof fetch, maxChars?: number }} [options] Wiring.
 * @returns {Promise<{ url: string, title: string, description: string, text: string, report: string }>} Page facts.
 * @throws {Error} When the URL is refused or the request fails.
 */
export async function fetchPage(rawUrl, options = {}) {
  const checked = checkUrl(rawUrl);
  if (checked.error !== undefined) throw new Error(checked.error);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxChars = Math.max(200, Number(options.maxChars) || 4000);
  const resolved = await resolveShortLink(checked.url, fetchImpl);
  // A logged-in provider sends its cookie along, which is the whole point of the
  // optional account: some pages only render for a signed-in visitor.
  const cookie = typeof options.cookieFor === 'function' ? options.cookieFor(resolved) : '';

  const bvid = bvidOf(resolved);
  if (bvid !== '') {
    const video = await bilibiliVideo(bvid, fetchImpl, cookie);
    if (video !== undefined) {
      const lines = [`B站视频：${video.title}`];
      if (video.owner !== '') lines.push(`UP主：${video.owner}`);
      if (video.description !== '') lines.push(`简介：${video.description.slice(0, 300)}`);
      lines.push(`链接：${resolved}`);
      const report = lines.join('\n');
      return { url: resolved, title: video.title, description: video.description, text: report, report };
    }
  }

  const response = await fetchImpl(resolved, {
    headers: {
      'user-agent': USER_AGENT,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      referer: new URL(resolved).origin,
      ...(cookie === '' ? {} : { cookie }),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = String(response.headers.get('content-type') ?? '');
  if (type.includes('application/json')) {
    const raw = await response.text();
    return { url: resolved, title: '', description: '', text: raw.slice(0, maxChars), report: raw.slice(0, maxChars) };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const html = buffer.subarray(0, MAX_BYTES).toString('utf8');
  const fields = readPageMeta(html);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
  const report = [
    fields.title === '' ? resolved : `标题：${fields.title}`,
    fields.description === '' ? '' : `摘要：${fields.description}`,
    `链接：${resolved}`,
    text === '' ? '' : `正文：${text}`,
  ].filter(line => line !== '').join('\n');
  return { url: resolved, title: fields.title, description: fields.description, text, report };
}
