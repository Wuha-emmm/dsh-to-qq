import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, isPrivateHost, readPageMeta, bvidOf, resolveShortLink, fetchPage } from '../src/media/page.js';

test('the fetcher refuses localhost and private networks', () => {
  for (const url of ['http://127.0.0.1:3000/get_status', 'http://localhost/x', 'http://10.1.2.3/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://169.254.1.1/', 'http://[::1]/']) {
    assert.ok(checkUrl(url).error !== undefined, url);
  }
  assert.equal(checkUrl('https://www.bilibili.com/video/BV1xx411c7mD').url !== undefined, true);
  assert.equal(checkUrl('ftp://example.com/x').error !== undefined, true);
});

test('public addresses are not mistaken for private ones', () => {
  assert.equal(isPrivateHost('8.8.8.8'), false);
  assert.equal(isPrivateHost('bilibili.com'), false);
  assert.equal(isPrivateHost('172.32.0.1'), false);
});

test('page metadata prefers og tags over the title element', () => {
  const html = '<html><head><title>普通标题</title><meta property="og:title" content="OG 标题"><meta name="description" content="&amp; 摘要"></head></html>';
  const fields = readPageMeta(html);
  assert.equal(fields.title, 'OG 标题');
  assert.equal(fields.description, '& 摘要');
});

test('a BV id is read out of a video URL', () => {
  assert.equal(bvidOf('https://www.bilibili.com/video/BV1xx411c7mD?p=1'), 'BV1xx411c7mD');
  assert.equal(bvidOf('https://example.com/x'), '');
});

test('a short link is resolved before reading', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { url: 'https://www.bilibili.com/video/BV1xx411c7mD', ok: true, headers: new Map() };
  };
  const resolved = await resolveShortLink('https://b23.tv/UKaknKJ', fakeFetch);
  assert.equal(resolved, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.match(calls[0].init.headers['user-agent'], /Mozilla/);
});

test('a bilibili video is read through the API', async () => {
  const fakeFetch = async url => {
    if (url.includes('api.bilibili.com')) {
      return {
        ok: true,
        headers: new Map(),
        json: async () => ({ code: 0, data: { title: '视频标题', desc: '简介内容', owner: { name: 'UP主' }, duration: 300 } }),
      };
    }
    return { url: 'https://www.bilibili.com/video/BV1xx411c7mD', ok: true, headers: new Map() };
  };
  const page = await fetchPage('https://www.bilibili.com/video/BV1xx411c7mD', { fetchImpl: fakeFetch });
  assert.match(page.report, /视频标题/);
  assert.match(page.report, /UP主/);
});

test('an ordinary page returns its title and text', async () => {
  const fakeFetch = async () => ({
    url: 'https://example.com/a',
    ok: true,
    headers: new Map([['content-type', 'text/html; charset=utf-8']]),
    arrayBuffer: async () => Buffer.from('<html><head><title>示例</title><meta name="description" content="说明"></head><body><p>正文在这里</p></body></html>'),
  });
  const page = await fetchPage('https://example.com/a', { fetchImpl: fakeFetch });
  assert.match(page.report, /示例/);
  assert.match(page.report, /正文在这里/);
});

test('an HTTP error surfaces as a thrown error', async () => {
  const fakeFetch = async () => ({ url: 'https://example.com/403', ok: false, status: 403, headers: new Map() });
  await assert.rejects(() => fetchPage('https://example.com/403', { fetchImpl: fakeFetch }), /HTTP 403/);
});
