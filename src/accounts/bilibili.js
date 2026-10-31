/**
 * Bilibili login check.
 *
 * Sign-in itself happens in the dedicated browser window (`browser.js`); this
 * module only answers "is this cookie still a logged-in session, and who is it".
 */

/** A desktop Chrome identifier; the nav endpoint rejects bare clients. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
