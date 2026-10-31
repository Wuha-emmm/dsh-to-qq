import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cookieValue,
  mixinKey,
  signWbi,
  postComment,
  postDynamic,
  searchVideos,
  wbiMaterial,
  videoIds,
  reportHistory,
  userName,
  withMention,
} from '../src/accounts/bilibili-api.js';

const COOKIE = 'SESSDATA=abc; bili_jct=csrf123; DedeUserID=42';

test('the cookie parser picks the csrf token', () => {
  assert.equal(cookieValue(COOKIE, 'bili_jct'), 'csrf123');
  assert.equal(cookieValue(COOKIE, 'missing'), '');
});

test('the WBI mixin key is 32 characters', () => {
  assert.equal(mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45').length, 32);
});

test('WBI signing adds wts and a 32-hex w_rid', () => {
  const signed = signWbi({ foo: '114', bar: '514' }, '0123456789abcdef0123456789abcdef', 1_700_000_000);
  assert.equal(signed.wts, '1700000000');
  assert.match(signed.w_rid, /^[0-9a-f]{32}$/);
  // A different timestamp changes the signature.
  const other = signWbi({ foo: '114', bar: '514' }, '0123456789abcdef0123456789abcdef', 1_700_000_001);
  assert.notEqual(signed.w_rid, other.w_rid);
});

test('a signed-out cookie is refused before writing', async () => {
  const fakeFetch = async () => ({ json: async () => ({ code: -101, message: '账号未登录' }) });
  await assert.rejects(() => wbiMaterial(COOKIE, fakeFetch), /登录态无效/);
});

test('a comment is posted with csrf and reports the server answer', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/x/web-interface/nav')) {
      return { json: async () => ({ code: 0, data: { isLogin: true, uname: '阿蓝', wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/aaa.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/bbb.png' } } }) };
    }
    return { json: async () => ({ code: 0, data: { rpid: 1 } }) };
  };
  const result = await postComment({ aid: 123, message: '写得好', cookie: COOKIE }, fakeFetch);
  assert.equal(result.ok, true);
  const reply = calls.find(call => call.url.includes('/x/v2/reply/add'));
  assert.match(reply.init.body, /csrf=csrf123/);
  assert.match(reply.init.body, /oid=123/);
});

test('a refusal keeps the server message', async () => {
  const fakeFetch = async url => {
    if (url.includes('nav')) {
      return { json: async () => ({ code: 0, data: { isLogin: true, wbi_img: { img_url: 'https://x/a.png', sub_url: 'https://x/b.png' } } }) };
    }
    return { json: async () => ({ code: 12002, message: '评论内容包含敏感词' }) };
  };
  const result = await postComment({ aid: 1, message: 'x', cookie: COOKIE }, fakeFetch);
  assert.equal(result.ok, false);
  assert.match(result.message, /敏感词/);
});

test('a dynamic is signed and sent', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('nav')) {
      return { json: async () => ({ code: 0, data: { isLogin: true, wbi_img: { img_url: 'https://x/a.png', sub_url: 'https://x/b.png' } } }) };
    }
    return { json: async () => ({ code: 0, data: { dyn_id_str: '999' } }) };
  };
  const result = await postDynamic({ text: '今天也在折腾插件', cookie: COOKIE }, fakeFetch);
  assert.equal(result.ok, true);
  assert.match(result.message, /999/);
  const create = calls.find(call => call.url.includes('/x/dynamic/feed/create/dyn'));
  assert.match(create.url, /w_rid=/);
});

test('search returns video rows and tolerates a refusal', async () => {
  const fakeFetch = async url => {
    if (url.includes('nav')) {
      return { json: async () => ({ code: 0, data: { isLogin: true, wbi_img: { img_url: 'https://x/a.png', sub_url: 'https://x/b.png' } } }) };
    }
    return { json: async () => ({ code: 0, data: { result: [
      { bvid: 'BV1aa411c7mD', title: '<em class="keyword">三角洲</em>新赛季', author: '某人', play: 12345 },
      { bvid: '', title: 'bad row' },
    ] } }) };
  };
  const results = await searchVideos('三角洲', COOKIE, fakeFetch);
  assert.equal(results.length, 1);
  assert.equal(results[0].bvid, 'BV1aa411c7mD');
  assert.equal(results[0].title, '三角洲新赛季');
  const refused = await searchVideos('x', COOKIE, async () => ({ json: async () => ({ code: -412 }) }));
  assert.deepEqual(refused, []);
});

test('video ids are read from the view API', async () => {
  const fakeFetch = async () => ({ json: async () => ({ code: 0, data: { aid: 123, cid: 456, title: '标题' } }) });
  assert.deepEqual(await videoIds({ bvid: 'BV1aa411c7mD', cookie: '' }, fakeFetch), { aid: 123, cid: 456, title: '标题' });
});

test('a history report needs a real cid', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('/view')) return { json: async () => ({ code: 0, data: { aid: 123, cid: 456 } }) };
    if (String(url).includes('/nav')) return { json: async () => ({ code: 0, data: { isLogin: true, wbi_img: { img_url: 'https://x/a.png', sub_url: 'https://x/b.png' } } }) };
    return { json: async () => ({ code: 0 }) };
  };
  assert.equal(await reportHistory({ aid: 123, cookie: COOKIE }, fakeFetch), true);
  const report = calls.find(call => String(call.url).includes('/history/report'));
  assert.match(report.init.body, /cid=456/);
});

test('a mention is placed with a trailing space and not duplicated', () => {
  assert.equal(withMention('说法我认同。', '呜哈丶emmm'), '说法我认同。 @呜哈丶emmm');
  assert.equal(withMention('已经 @呜哈丶emmm 了', '呜哈丶emmm'), '已经 @呜哈丶emmm 了');
  assert.equal(withMention('没有昵称', ''), '没有昵称');
});

test('a uid resolves to the exact nickname that makes the mention link', async () => {
  const fakeFetch = async url => {
    if (String(url).includes('/nav')) {
      return { json: async () => ({ code: 0, data: { isLogin: true, wbi_img: { img_url: 'https://x/a.png', sub_url: 'https://x/b.png' } } }) };
    }
    assert.match(String(url), /acc\/info/);
    return { json: async () => ({ code: 0, data: { name: '呜哈丶emmm' } }) };
  };
  assert.equal(await userName(10217007, COOKIE, fakeFetch), '呜哈丶emmm');
  assert.equal(await userName(0, COOKIE, fakeFetch), '');
});

test('a comment can carry a resolved mention', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('/nav')) {
      return { json: async () => ({ code: 0, data: { isLogin: true, wbi_img: { img_url: 'https://x/a.png', sub_url: 'https://x/b.png' } } }) };
    }
    if (String(url).includes('acc/info')) return { json: async () => ({ code: 0, data: { name: '呜哈丶emmm' } }) };
    return { json: async () => ({ code: 0 }) };
  };
  const result = await postComment({ aid: 5, message: '说得好。', cookie: COOKIE, mentionUid: 10217007 }, fakeFetch);
  assert.equal(result.ok, true);
  const reply = calls.find(call => String(call.url).includes('/reply/add'));
  assert.match(decodeURIComponent(reply.init.body.replace(/\+/g, ' ')), /@呜哈丶emmm/);
});
