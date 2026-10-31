import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../src/accounts/store.js';
import { cookieHeader, pollQrLogin, verifyLogin, startQrLogin } from '../src/accounts/bilibili.js';
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

test('set-cookie headers collapse into one cookie header', () => {
  assert.equal(
    cookieHeader(['SESSDATA=abc; Path=/; HttpOnly', 'bili_jct=def; Path=/', 'SESSDATA=over']),
    'SESSDATA=over; bili_jct=def',
  );
});

test('the QR flow reports waiting and then done with cookies', async () => {
  const start = await startQrLogin(async () => ({ json: async () => ({ code: 0, data: { qrcode_key: 'k1', url: 'https://x' } }) }));
  assert.deepEqual(start, { key: 'k1', url: 'https://x' });

  const waiting = await pollQrLogin('k1', async () => ({ headers: { getSetCookie: () => [] }, json: async () => ({ code: 0, data: { code: 86101 } }) }));
  assert.equal(waiting.state, 'waiting');

  const done = await pollQrLogin('k1', async () => ({
    headers: { getSetCookie: () => ['SESSDATA=zzz; Path=/'] },
    json: async () => ({ code: 0, data: { code: 0 } }),
  }));
  assert.equal(done.state, 'done');
  assert.equal(done.cookie, 'SESSDATA=zzz');
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
