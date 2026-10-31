/**
 * Bilibili account helpers: QR sign-in and a login check.
 *
 * The QR flow is the only password-free way in: the phone scans, Bilibili hands
 * back the session cookies, and the bridge stores them. Nothing here sends a
 * password anywhere.
 */

/** A desktop Chrome identifier; passport endpoints reject bare clients. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Poll states returned by the passport endpoint. */
const POLL_CODES = {
  0: 'done',
  86101: 'waiting',
  86090: 'scanned',
  86038: 'expired',
};

/**
 * Turn `set-cookie` headers into one `Cookie` request header.
 *
 * @param {ReadonlyArray<string>} headers Raw set-cookie values.
 * @returns {string} `name=value; …`, without attributes.
 */
export function cookieHeader(headers) {
  const pairs = [];
  for (const header of Array.isArray(headers) ? headers : []) {
    const first = String(header).split(';')[0].trim();
    if (first !== '' && first.includes('=')) pairs.push(first);
  }
  // Later values win, which matches how a browser jar behaves for duplicates.
  const merged = new Map();
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    merged.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return [...merged].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Ask Bilibili for a sign-in QR code.
 *
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<{ key: string, url: string }>} Poll key and the QR page URL.
 * @throws {Error} When the endpoint refuses.
 */
export async function startQrLogin(fetchImpl = fetch) {
  const response = await fetchImpl('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
    headers: { 'user-agent': USER_AGENT, referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json();
  if (Number(payload?.code) !== 0 || typeof payload?.data?.qrcode_key !== 'string') {
    throw new Error(`qr generate failed: ${payload?.message ?? 'unknown'}`);
  }
  return { key: payload.data.qrcode_key, url: String(payload.data.url ?? '') };
}

/**
 * Poll one QR sign-in attempt.
 *
 * @param {string} key Poll key from `startQrLogin`.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<{ state: 'waiting' | 'scanned' | 'expired' | 'done', cookie: string }>} Progress.
 */
export async function pollQrLogin(key, fetchImpl = fetch) {
  const response = await fetchImpl(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`,
    {
      headers: { 'user-agent': USER_AGENT, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(10_000),
    },
  );
  const raw = typeof response.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const payload = await response.json();
  const code = Number(payload?.data?.code ?? payload?.code ?? -1);
  const state = POLL_CODES[code] ?? (Number(payload?.code) === 0 ? 'waiting' : 'expired');
  if (state !== 'done') return { state, cookie: '' };
  return { state, cookie: cookieHeader(raw) };
}

/**
 * Verify a stored cookie and read the display name.
 *
 * @param {string} cookie Cookie header.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<{ ok: boolean, nickname: string, uid: number }>} Login state.
 */
export async function verifyLogin(cookie, fetchImpl = fetch) {
  if (String(cookie ?? '').trim() === '') return { ok: false, nickname: '', uid: 0 };
  try {
    const response = await fetchImpl('https://api.bilibili.com/x/web-interface/nav', {
      headers: { cookie, 'user-agent': USER_AGENT, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    const data = payload?.data ?? {};
    return {
      ok: Number(payload?.code) === 0 && data.isLogin === true,
      nickname: String(data.uname ?? ''),
      uid: Number(data.mid) || 0,
    };
  } catch {
    return { ok: false, nickname: '', uid: 0 };
  }
}
