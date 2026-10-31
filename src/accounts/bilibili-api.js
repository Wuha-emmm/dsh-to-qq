/**
 * Writing to Bilibili with a signed-in cookie.
 *
 * Read APIs need nothing special; write APIs need the `bili_jct` token as `csrf`
 * and, for newer endpoints, a WBI signature. Both are derived here from the
 * cookie the sign-in browser produced.
 *
 * These calls can be declined by Bilibili's risk control (HTTP 412 / code -412)
 * when they come from something that is not the phone app; the caller always gets
 * the server's own message instead of a guess.
 */

import { createHash } from 'node:crypto';

/** A desktop Chrome identifier. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Fixed permutation used to mix the two WBI keys (published by Bilibili). */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

/**
 * Read one cookie value out of a cookie header.
 *
 * @param {string} header Cookie header.
 * @param {string} name Cookie name.
 * @returns {string} Value, or ''.
 */
export function cookieValue(header, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(String(header ?? ''));
  return match === null ? '' : match[1];
}

/**
 * Mix the two WBI keys into the signing key.
 *
 * @param {string} imgKey Key from the image URL.
 * @param {string} subKey Key from the sub URL.
 * @returns {string} 32-character key.
 */
export function mixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  return MIXIN_KEY_ENC_TAB.map(index => raw[index] ?? '').join('').slice(0, 32);
}

/**
 * Sign query parameters the WBI way.
 *
 * @param {Record<string, string | number>} params Parameters.
 * @param {string} key Mixed key.
 * @param {number} [nowSeconds] Timestamp; defaults to now.
 * @returns {Record<string, string>} Parameters plus `wts` and `w_rid`.
 */
export function signWbi(params, key, nowSeconds = Math.floor(Date.now() / 1000)) {
  const withTime = { ...params, wts: String(nowSeconds) };
  const query = Object.keys(withTime)
    .sort()
    .map(name => `${encodeURIComponent(name)}=${encodeURIComponent(String(withTime[name]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = createHash('md5').update(`${query}${key}`).digest('hex');
  return { ...withTime, w_rid: wRid };
}

/**
 * Fetch the WBI keys for a signed-in cookie.
 *
 * @param {string} cookie Cookie header.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<{ key: string, csrf: string, nickname: string }>} Signing material.
 * @throws {Error} When the cookie is not signed in.
 */
export async function wbiMaterial(cookie, fetchImpl = fetch) {
  const response = await fetchImpl('https://api.bilibili.com/x/web-interface/nav', {
    headers: { cookie, 'user-agent': USER_AGENT, referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json();
  if (Number(payload?.code) !== 0 || payload?.data?.isLogin !== true) {
    throw new Error(`B站登录态无效：${payload?.message ?? 'not signed in'}`);
  }
  const imgUrl = String(payload.data.wbi_img?.img_url ?? '');
  const subUrl = String(payload.data.wbi_img?.sub_url ?? '');
  const imgKey = imgUrl.split('/').pop()?.split('.')[0] ?? '';
  const subKey = subUrl.split('/').pop()?.split('.')[0] ?? '';
  return {
    key: mixinKey(imgKey, subKey),
    csrf: cookieValue(cookie, 'bili_jct'),
    nickname: String(payload.data.uname ?? ''),
  };
}

/**
 * Read a user's display name by uid.
 *
 * A Bilibili mention only links when the text carries the account's exact
 * nickname followed by a space; a QQ nickname or a bare uid never resolves.
 *
 * @param {number} mid User id.
 * @param {string} cookie Cookie header.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<string>} Nickname, or '' when unknown.
 */
export async function userName(mid, cookie, fetchImpl = fetch) {
  const id = Number(mid) || 0;
  if (id <= 0) return '';
  let key;
  try {
    ({ key } = await wbiMaterial(cookie, fetchImpl));
  } catch {
    return '';
  }
  const signed = signWbi({ mid: String(id) }, key);
  const query = new URLSearchParams(signed).toString();
  try {
    const response = await fetchImpl(`https://api.bilibili.com/x/space/wbi/acc/info?${query}`, {
      headers: {
        cookie,
        'user-agent': USER_AGENT,
        referer: `https://space.bilibili.com/${id}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    if (Number(payload?.code) !== 0) return '';
    return String(payload?.data?.name ?? '');
  } catch {
    return '';
  }
}

/**
 * Make sure a comment body carries a real mention of the nickname.
 *
 * @param {string} message Comment text.
 * @param {string} nickname Bilibili nickname.
 * @returns {string} Text with `@nickname ` present.
 */
export function withMention(message, nickname) {
  const name = String(nickname ?? '').trim();
  const body = String(message ?? '').trim();
  if (name === '') return body;
  if (body.includes(`@${name}`)) return body;
  return `${body} @${name} `.trimEnd();
}

/**
 * Read the numeric ids of a video.
 *
 * @param {{ bvid?: string, aid?: number, cookie: string }} request Video identity.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<{ aid: number, cid: number, title: string } | undefined>} Ids and title.
 */
export async function videoIds(request, fetchImpl = fetch) {
  const query = request.bvid !== undefined && request.bvid !== ''
    ? `bvid=${encodeURIComponent(request.bvid)}`
    : `aid=${Number(request.aid) || 0}`;
  if (query === 'aid=0' || query === 'bvid=') return undefined;
  try {
    const response = await fetchImpl(`https://api.bilibili.com/x/web-interface/view?${query}`, {
      headers: {
        cookie: request.cookie,
        'user-agent': USER_AGENT,
        referer: 'https://www.bilibili.com/',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    if (Number(payload?.code) !== 0) return undefined;
    const data = payload.data ?? {};
    return {
      aid: Number(data.aid) || 0,
      cid: Number(data.cid) || Number(data.pages?.[0]?.cid) || 0,
      title: String(data.title ?? ''),
    };
  } catch {
    return undefined;
  }
}

/**
 * Post a comment on a video.
 *
 * @param {{ aid: number, message: string, cookie: string, mentionUid?: number }} request Comment details.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<{ ok: boolean, message: string }>} Result.
 */
export async function postComment(request, fetchImpl = fetch) {
  const aid = Number(request.aid) || 0;
  const message = String(request.message ?? '').trim();
  if (aid <= 0) return { ok: false, message: '缺少视频 aid' };
  if (message === '') return { ok: false, message: '评论内容为空' };
  const { csrf } = await wbiMaterial(request.cookie, fetchImpl);
  if (csrf === '') return { ok: false, message: 'cookie 里没有 bili_jct，无法发评论' };
  // A mention only links with the exact nickname and a trailing space.
  let body = message;
  if (Number(request.mentionUid) > 0) {
    const nickname = request.mentionNickname === undefined
      ? await userName(Number(request.mentionUid), request.cookie, fetchImpl)
      : String(request.mentionNickname);
    if (nickname !== '') body = withMention(body, nickname);
  }
  const form = new URLSearchParams({
    oid: String(aid),
    type: '1',
    message: body,
    plat: '1',
    ordering: 'nano',
    csrf,
  });
  const response = await fetchImpl('https://api.bilibili.com/x/v2/reply/add', {
    method: 'POST',
    headers: {
      cookie: request.cookie,
      'user-agent': USER_AGENT,
      referer: `https://www.bilibili.com/video/av${aid}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (Number(payload?.code) === 0) return { ok: true, message: '评论已发布' };
  return { ok: false, message: `B站拒绝：${payload?.message ?? `HTTP ${response.status}`}（code ${payload?.code ?? '?'}）` };
}

/**
 * Publish a plain-text dynamic.
 *
 * @param {{ text: string, cookie: string }} request Dynamic details.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<{ ok: boolean, message: string }>} Result.
 */
export async function postDynamic(request, fetchImpl = fetch) {
  const text = String(request.text ?? '').trim();
  if (text === '') return { ok: false, message: '动态内容为空' };
  const { key, csrf } = await wbiMaterial(request.cookie, fetchImpl);
  if (csrf === '') return { ok: false, message: 'cookie 里没有 bili_jct，无法发动态' };
  const dynReq = {
    content: {
      contents: [{ raw_text: text.slice(0, 1000), type: 1, biz_id: '' }],
      scene: 1,
      attach_card: null,
    },
    meta: { app_meta: { from: 'create.dynamic.web' } },
  };
  const signed = signWbi({ dyn_req: JSON.stringify(dynReq), csrf }, key);
  const query = new URLSearchParams(signed).toString();
  const response = await fetchImpl(`https://api.bilibili.com/x/dynamic/feed/create/dyn?${query}`, {
    method: 'POST',
    headers: {
      cookie: request.cookie,
      'user-agent': USER_AGENT,
      referer: 'https://t.bilibili.com/',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ dyn_req: dynReq, scene: 1 }),
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (Number(payload?.code) === 0) {
    const id = String(payload?.data?.dyn_id_str ?? payload?.data?.dyn_id ?? '');
    return { ok: true, message: id === '' ? '动态已发布' : `动态已发布（id ${id}）` };
  }
  return { ok: false, message: `B站拒绝：${payload?.message ?? `HTTP ${response.status}`}（code ${payload?.code ?? '?'}）` };
}

/**
 * Report a video as watched, which is what puts it in the account's history.
 *
 * @param {{ aid: number, cookie: string }} request Video details.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<boolean>} True when Bilibili accepted the report.
 */
export async function reportHistory(request, fetchImpl = fetch) {
  const aid = Number(request.aid) || 0;
  if (aid <= 0) return false;
  // The endpoint ignores a report without a real cid, so look it up first.
  const ids = await videoIds({ aid, bvid: request.bvid, cookie: request.cookie }, fetchImpl);
  const cid = Number(request.cid) || ids?.cid || 0;
  if (cid <= 0) return false;
  const { csrf } = await wbiMaterial(request.cookie, fetchImpl).catch(() => ({ csrf: '' }));
  const form = new URLSearchParams({ aid: String(aid), cid: String(cid), progress: '30', type: '3', platform: 'web' });
  if (csrf !== '') form.set('csrf', csrf);
  try {
    const response = await fetchImpl('https://api.bilibili.com/x/v2/history/report', {
      method: 'POST',
      headers: {
        cookie: request.cookie,
        'user-agent': USER_AGENT,
        referer: `https://www.bilibili.com/video/av${aid}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => ({}));
    return Number(payload?.code) === 0;
  } catch {
    return false;
  }
}

/**
 * Search videos through the signed WBI endpoint.
 *
 * @param {string} keyword Search words.
 * @param {string} cookie Cookie header.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<Array<{ bvid: string, title: string, author: string, play: number, url: string }>>} Results.
 */
export async function searchVideos(keyword, cookie, fetchImpl = fetch) {
  const words = String(keyword ?? '').trim();
  if (words === '') return [];
  // A signed-out or risk-controlled account simply has no results to show.
  let key;
  try {
    ({ key } = await wbiMaterial(cookie, fetchImpl));
  } catch {
    return [];
  }
  const signed = signWbi({ search_type: 'video', keyword: words, page: 1, page_size: 10 }, key);
  const query = new URLSearchParams(signed).toString();
  const response = await fetchImpl(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`, {
    headers: {
      cookie,
      'user-agent': USER_AGENT,
      referer: `https://search.bilibili.com/all?keyword=${encodeURIComponent(words)}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (Number(payload?.code) !== 0) return [];
  const results = Array.isArray(payload?.data?.result) ? payload.data.result : [];
  return results
    .filter(item => typeof item?.bvid === 'string' && item.bvid !== '')
    .slice(0, 10)
    .map(item => ({
      bvid: String(item.bvid),
      title: String(item.title ?? '').replace(/<[^>]+>/g, ''),
      author: String(item.author ?? ''),
      play: Number(item.play) || 0,
      url: `https://www.bilibili.com/video/${item.bvid}`,
    }));
}

/**
 * Read a video's subtitles (manual or the AI-generated track).
 *
 * `/x/player/wbi/v2` lists the tracks for a signed-in viewer; the track itself is
 * a JSON file with `{ from, to, content }` rows, which is the cheapest way to know
 * what a video actually says.
 *
 * @param {{ aid: number, cid: number, bvid?: string, cookie: string }} request Video identity.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<{ lan: string, lanDoc: string, lines: Array<{ from: number, to: number, text: string }>, text: string, chars: number } | undefined>} Transcript.
 */
export async function videoSubtitles(request, fetchImpl = fetch) {
  const aid = Number(request.aid) || 0;
  const cid = Number(request.cid) || 0;
  if (aid <= 0 || cid <= 0) return undefined;
  let key;
  try {
    ({ key } = await wbiMaterial(request.cookie, fetchImpl));
  } catch {
    key = '';
  }
  const params = { aid: String(aid), cid: String(cid), ...(request.bvid ? { bvid: request.bvid } : {}) };
  const signed = key === '' ? params : signWbi(params, key);
  const query = new URLSearchParams(signed).toString();
  const playerUrl = key === ''
    ? `https://api.bilibili.com/x/player/v2?${query}`
    : `https://api.bilibili.com/x/player/wbi/v2?${query}`;
  let payload;
  try {
    const response = await fetchImpl(playerUrl, {
      headers: {
        cookie: request.cookie,
        'user-agent': USER_AGENT,
        referer: `https://www.bilibili.com/video/${request.bvid ?? `av${aid}`}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    payload = await response.json();
  } catch {
    return undefined;
  }
  if (Number(payload?.code) !== 0) return undefined;
  const tracks = payload?.data?.subtitle?.subtitles;
  if (!Array.isArray(tracks) || tracks.length === 0) return undefined;
  const track = tracks.find(item => String(item?.subtitle_url ?? '') !== '') ?? tracks[0];
  const rawUrl = String(track.subtitle_url ?? '');
  if (rawUrl === '') return undefined;
  const url = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
  try {
    const response = await fetchImpl(url, {
      headers: { cookie: request.cookie, 'user-agent': USER_AGENT, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    const rows = Array.isArray(body?.body) ? body.body : [];
    const lines = rows.map(row => ({
      from: Number(row.from) || 0,
      to: Number(row.to) || 0,
      text: String(row.content ?? '').trim(),
    })).filter(line => line.text !== '');
    const text = lines.map(line => line.text).join('\n');
    return {
      lan: String(track.lan ?? ''),
      lanDoc: String(track.lan_doc ?? ''),
      lines,
      text,
      chars: text.length,
    };
  } catch {
    return undefined;
  }
}
