/**
 * A separate browser window for manual sign-in.
 *
 * Bilibili and Xiaohongshu no longer offer a QR sign-in that a third-party
 * client can complete, so the honest path is a real browser where the person
 * types their own credentials. It runs on its own profile directory, so it never
 * touches the browser they already use, and cookies are read back over the
 * DevTools protocol instead of asking them to copy anything.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/** Browsers to try, in order, when no explicit path is configured. */
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

/** Domains each provider's cookies belong to. */
const DOMAINS = {
  bilibili: ['bilibili.com', 'b23.tv'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
};

/**
 * Locate an installed Chromium browser.
 *
 * @param {string} [configured] Path from the settings page.
 * @returns {string} Executable path, or '' when none was found.
 */
export function findBrowser(configured = '') {
  const wanted = String(configured ?? '').trim();
  if (wanted !== '' && existsSync(wanted)) return wanted;
  for (const candidate of CANDIDATES) if (existsSync(candidate)) return candidate;
  return '';
}

/**
 * Start the sign-in browser on its own profile.
 *
 * @param {{ browser: string, profileDir: string, url: string, port: number }} options Wiring.
 * @returns {import('node:child_process').ChildProcess} The spawned process.
 */
export async function launchBrowser(options) {
  const { browser, profileDir, url, port } = options;
  if (browser === '') throw new Error('没有找到 Edge 或 Chrome，请在设置里填写浏览器路径');
  await mkdir(profileDir, { recursive: true });
  const child = spawn(browser, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--new-window',
    url,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

/**
 * Read the DevTools WebSocket endpoint of a running browser.
 *
 * @param {number} port Debug port.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<string>} WebSocket URL.
 * @throws {Error} When the browser is not listening yet.
 */
export async function devtoolsEndpoint(port, fetchImpl = fetch) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
  const payload = await response.json();
  const socket = String(payload?.webSocketDebuggerUrl ?? '');
  if (socket === '') throw new Error('浏览器的调试端口没有响应，可能还没启动完');
  return socket;
}

/**
 * Send one DevTools command and resolve its result.
 *
 * @param {any} socket Connected WebSocket.
 * @param {number} id Command id.
 * @param {string} method DevTools method.
 * @param {Record<string, unknown>} [params] Method parameters.
 * @param {number} [timeoutMs] How long the command may take.
 * @returns {Promise<any>} The `result` field.
 */
function command(socket, id, method, params = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), timeoutMs);
    const onMessage = event => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload?.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      if (payload.error !== undefined) reject(new Error(`${method}: ${payload.error.message}`));
      else resolve(payload.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Open one URL in the sign-in browser (which is what writes its history).
 *
 * @param {number} port Debug port.
 * @param {string} url Target URL.
 * @param {{ WebSocketImpl?: typeof WebSocket, fetchImpl?: typeof fetch }} [options] Wiring.
 * @returns {Promise<boolean>} True when a tab was created.
 */
export async function openUrl(port, url, options = {}) {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const endpoint = await devtoolsEndpoint(port, options.fetchImpl);
  const socket = new WebSocketImpl(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('devtools 连接超时')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('devtools 连接失败')); }, { once: true });
  });
  try {
    await command(socket, 1, 'Target.createTarget', { url });
    return true;
  } catch {
    return false;
  } finally {
    socket.close();
  }
}

/**
 * List the pages a running sign-in browser has open.
 *
 * @param {number} port Debug port.
 * @param {typeof fetch} [fetchImpl] Fetch implementation.
 * @returns {Promise<Array<{ url: string, socket: string }>>} Page targets.
 */
export async function listPages(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    const payload = await response.json();
    return (Array.isArray(payload) ? payload : [])
      .filter(page => page?.type === 'page' && typeof page.webSocketDebuggerUrl === 'string')
      .map(page => ({ url: String(page.url ?? ''), socket: String(page.webSocketDebuggerUrl) }));
  } catch {
    return [];
  }
}

/**
 * Run a script inside one page of the sign-in browser.
 *
 * @param {string} socket Page DevTools socket.
 * @param {string} expression JavaScript source; its value is returned.
 * @param {{ WebSocketImpl?: typeof WebSocket, timeoutMs?: number }} [options] Wiring.
 * @returns {Promise<any>} Script result.
 */
export async function evaluateInPage(socket, expression, options = {}) {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const ws = new WebSocketImpl(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('devtools 连接超时')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('devtools 连接失败')); }, { once: true });
  });
  try {
    const result = await command(ws, 1, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, options.timeoutMs ?? 30_000);
    return result?.result?.value;
  } finally {
    ws.close();
  }
}

/**
 * Find the open page for a video and play it muted for a while.
 *
 * Bilibili only writes a watch-history entry once playback reports progress, so a
 * short muted play is the honest way to make the visit real.
 *
 * @param {number} port Debug port.
 * @param {string} bvid Video id to look for.
 * @param {number} [seconds] How long to play.
 * @returns {Promise<string>} What happened: 'played', 'no-page', 'no-video', or an error.
 */
export async function playInBrowser(port, bvid, seconds = 12) {
  const pages = await listPages(port);
  const page = pages.find(item => item.url.includes(bvid));
  if (page === undefined) return 'no-page';
  const script = `(async () => {
    const video = document.querySelector('video');
    if (video === null) return 'no-video';
    video.muted = true;
    try { await video.play(); } catch (error) { return 'blocked'; }
    await new Promise(resolve => setTimeout(resolve, ${Math.max(3, Math.min(60, Number(seconds) || 12)) * 1000}));
    video.pause();
    return 'played';
  })()`;
  try {
    return String(await evaluateInPage(page.socket, script));
  } catch (error) {
    return `error:${String(error?.message ?? error).slice(0, 60)}`;
  }
}

/**
 * Read every cookie from a running sign-in browser.
 *
 * @param {number} port Debug port.
 * @param {{ WebSocketImpl?: typeof WebSocket, fetchImpl?: typeof fetch }} [options] Wiring.
 * @returns {Promise<Array<{ name: string, value: string, domain: string }>>} Cookies.
 */
export async function readBrowserCookies(port, options = {}) {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const endpoint = await devtoolsEndpoint(port, options.fetchImpl);
  const socket = new WebSocketImpl(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('devtools 连接超时')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('devtools 连接失败')); }, { once: true });
  });
  try {
    const result = await command(socket, 1, 'Storage.getCookies', {});
    return (Array.isArray(result?.cookies) ? result.cookies : [])
      .map(cookie => ({
        name: String(cookie.name ?? ''),
        value: String(cookie.value ?? ''),
        domain: String(cookie.domain ?? ''),
      }))
      .filter(cookie => cookie.name !== '' && cookie.domain !== '');
  } finally {
    socket.close();
  }
}

/**
 * Build one `Cookie` header from cookies of the requested provider.
 *
 * @param {ReadonlyArray<{ name: string, value: string, domain: string }>} cookies Cookies from the browser.
 * @param {string} provider Provider key.
 * @returns {string} `name=value; …`, or '' when the browser is not signed in there.
 */
export function cookieHeaderFrom(cookies, provider) {
  const suffixes = DOMAINS[provider] ?? [];
  const seen = new Map();
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const domain = String(cookie.domain ?? '').replace(/^\./, '').toLowerCase();
    if (!suffixes.some(suffix => domain === suffix || domain.endsWith(`.${suffix}`))) continue;
    seen.set(cookie.name, cookie.value);
  }
  return [...seen].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Whether a cookie header looks like a signed-in Bilibili session.
 *
 * @param {string} header Cookie header.
 * @returns {boolean} True when SESSDATA is present.
 */
export function hasBilibiliSession(header) {
  return /(?:^|;\s*)SESSDATA=/.test(String(header ?? ''));
}

export { DOMAINS };
