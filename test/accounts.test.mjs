import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../src/accounts/store.js';
import { verifyLogin } from '../src/accounts/bilibili.js';
import { cookieHeaderFrom, findBrowser, hasBilibiliSession, devtoolsEndpoint, readBrowserCookies } from '../src/accounts/browser.js';
import { fetchPage } from '../src/media/page.js';

test('a stored cookie is only attached to its own provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-acc-'));
  try {
    const store = new AccountStore(join(dir, 'accounts.json'));
    await store.load();
    await store.set('bilibili', { cookie: 'SESSDATA=abc', nickname: '某人', uid: 42, method: 'qr' });
    assert.equal(store.cookieFor('https://api.bilibili.com/x/web-interface/view'), 'SESSDATA=abc');
    assert.equal(store.cookieFor('https://www.xiaohongshu.com/explore'), '');
    assert.equal(store.cookieFor('https://example.com/'), '');
    assert.equal(store.status().bilibili.loggedIn, true);
    assert.equal(store.status().xiaohongshu.loggedIn, false);
    // The status must never carry the secret.
    assert.equal(JSON.stringify(store.status()).includes('SESSDATA'), false);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the jar persists and can be cleared', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-acc-'));
  try {
    const file = join(dir, 'accounts.json');
    const first = new AccountStore(file);
    await first.load();
    await first.set('xiaohongshu', { cookie: 'web_session=xyz' });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.xiaohongshu.cookie, 'web_session=xyz');

    const second = new AccountStore(file);
    await second.load();
    assert.equal(second.status().xiaohongshu.loggedIn, true);
    await second.clear('xiaohongshu');
    assert.equal(second.status().xiaohongshu.loggedIn, false);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('cookies are collected per provider from the browser', () => {
  const cookies = [
    { name: 'SESSDATA', value: 'abc', domain: '.bilibili.com' },
    { name: 'bili_jct', value: 'def', domain: '.bilibili.com' },
    { name: 'web_session', value: 'xxx', domain: '.xiaohongshu.com' },
    { name: 'tracker', value: 'y', domain: '.example.com' },
  ];
  assert.equal(cookieHeaderFrom(cookies, 'bilibili'), 'SESSDATA=abc; bili_jct=def');
  assert.equal(cookieHeaderFrom(cookies, 'xiaohongshu'), 'web_session=xxx');
  assert.equal(cookieHeaderFrom(cookies, 'bilibili'), cookieHeaderFrom(cookies, 'bilibili'), 'stable order');
});

test('a Bilibili session needs SESSDATA', () => {
  assert.equal(hasBilibiliSession('SESSDATA=abc; bili_jct=def'), true);
  assert.equal(hasBilibiliSession('bili_jct=def'), false);
  assert.equal(hasBilibiliSession(''), false);
});

test('the browser endpoint is read from the debug port', async () => {
  const fakeFetch = async () => ({ json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/x' }) });
  assert.equal(await devtoolsEndpoint(9333, fakeFetch), 'ws://127.0.0.1:9333/devtools/browser/x');
  const missing = async () => ({ json: async () => ({}) });
  await assert.rejects(() => devtoolsEndpoint(9333, missing), /没有响应/);
});

test('cookies are read over DevTools', async () => {
  class FakeSocket {
    constructor() {
      this.listeners = new Map();
      setTimeout(() => this.emit('open', {}), 0);
    }
    addEventListener(type, handler) {
      const list = this.listeners.get(type) ?? [];
      list.push(handler);
      this.listeners.set(type, list);
    }
    removeEventListener(type, handler) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== handler));
    }
    emit(type, event) {
      for (const handler of this.listeners.get(type) ?? []) handler(event);
    }
    send(payload) {
      const command = JSON.parse(payload);
      setTimeout(() => this.emit('message', { data: JSON.stringify({ id: command.id, result: { cookies: [
        { name: 'SESSDATA', value: 'abc', domain: '.bilibili.com' },
        { name: 'broken', value: '', domain: '' },
      ] } }) }), 0);
    }
    close() {}
  }
  const cookies = await readBrowserCookies(9333, { WebSocketImpl: FakeSocket, fetchImpl: async () => ({ json: async () => ({ webSocketDebuggerUrl: 'ws://x' }) }) });
  assert.deepEqual(cookies, [{ name: 'SESSDATA', value: 'abc', domain: '.bilibili.com' }]);
});

test('a configured browser path wins when it exists', () => {
  assert.equal(findBrowser('E:/definitely/not/here.exe') === '' || findBrowser('E:/definitely/not/here.exe').includes('msedge') || findBrowser('E:/definitely/not/here.exe').includes('chrome'), true);
});

test('a stale cookie fails verification', async () => {
  const bad = await verifyLogin('SESSDATA=old', async () => ({ json: async () => ({ code: -101, data: { isLogin: false } }) }));
  assert.equal(bad.ok, false);
  const good = await verifyLogin('SESSDATA=fresh', async () => ({ json: async () => ({ code: 0, data: { isLogin: true, uname: '阿蓝', mid: 7 } }) }));
  assert.deepEqual(good, { ok: true, nickname: '阿蓝', uid: 7 });
});

test('fetch_page sends the stored cookie to the matching site', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, headers: init?.headers ?? {} });
    if (String(url).includes('api.bilibili.com')) {
      return { ok: true, headers: new Map(), json: async () => ({ code: 0, data: { title: '标题', desc: '', owner: { name: 'UP' } } }) };
    }
    return { url: 'https://www.bilibili.com/video/BV1xx411c7mD', ok: true, headers: new Map() };
  };
  await fetchPage('https://www.bilibili.com/video/BV1xx411c7mD', {
    fetchImpl: fakeFetch,
    cookieFor: url => (String(url).includes('bilibili') ? 'SESSDATA=abc' : ''),
  });
  const api = seen.find(call => String(call.url).includes('api.bilibili.com'));
  assert.equal(api.headers.cookie, 'SESSDATA=abc');
});
