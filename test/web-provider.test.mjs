import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchProvider } from '../src/web/provider.js';

const json = body => ({ json: async () => body });

test('the provider refuses localhost and private networks', async () => {
  const provider = createFetchProvider();
  for (const url of ['http://127.0.0.1:3000/get_status', 'http://192.168.1.1/', 'http://localhost/x']) {
    await assert.rejects(() => provider.fetch({ url }), /内网|本机/, url);
  }
});

test('a bilibili video comes back as readable text', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('api.bilibili.com')) {
      return json({ code: 0, data: { aid: 1, cid: 2, title: '视频标题', desc: '简介', owner: { name: 'UP主' }, stat: { reply: 9 } } });
    }
    if (String(url).includes('/nav')) {
      return json({ code: 0, data: { isLogin: true, wbi_img: { img_url: 'https://x/a.png', sub_url: 'https://x/b.png' } } });
    }
    return { url: 'https://www.bilibili.com/video/BV1aa411c7mD', status: 200, headers: new Map(), arrayBuffer: async () => Buffer.from('<html></html>') };
  };
  try {
    const provider = createFetchProvider();
    const result = await provider.fetch({ url: 'https://www.bilibili.com/video/BV1aa411c7mD' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.kind, 'text');
    assert.match(result.body.content, /视频标题/);
    assert.match(result.body.content, /UP主/);
  } finally {
    globalThis.fetch = original;
  }
});

test('an ordinary page keeps its HTML for the tool to extract', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    url: 'https://example.com/a',
    status: 200,
    headers: new Map([['content-type', 'text/html; charset=utf-8']]),
    arrayBuffer: async () => Buffer.from('<html><title>示例</title></html>'),
  });
  try {
    const provider = createFetchProvider();
    const result = await provider.fetch({ url: 'https://example.com/a' });
    assert.equal(result.body.kind, 'html');
    assert.match(result.body.content, /示例/);
    assert.equal(result.url, 'https://example.com/a');
  } finally {
    globalThis.fetch = original;
  }
});

test('the stored cookie is attached only for the matching site', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), cookie: init?.headers?.cookie ?? '' });
    return { url: String(url), status: 200, headers: new Map(), arrayBuffer: async () => Buffer.from('<html></html>') };
  };
  try {
    const provider = createFetchProvider({ cookieFor: url => (String(url).includes('bilibili') ? 'SESSDATA=abc' : '') });
    await provider.fetch({ url: 'https://www.bilibili.com/read/cv1' });
    await provider.fetch({ url: 'https://example.com/x' });
    const bili = seen.find(call => call.url.includes('bilibili'));
    const other = seen.find(call => call.url.includes('example.com'));
    assert.equal(bili.cookie, 'SESSDATA=abc');
    assert.equal(other.cookie, '');
  } finally {
    globalThis.fetch = original;
  }
});
