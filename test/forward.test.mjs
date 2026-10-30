import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardSegments, formatForward, fetchForwards } from '../src/media/forward.js';

test('forwardSegments keeps only forwards that carry an id', () => {
  const segments = [
    { type: 'text', data: { text: 'hi' } },
    { type: 'forward', data: { id: 'abc' } },
    { type: 'forward', data: {} },
  ];
  assert.equal(forwardSegments(segments).length, 1);
  assert.deepEqual(forwardSegments(undefined), []);
});

test('formatForward reads both response shapes', () => {
  const flat = { messages: [{ sender: { nickname: '阿明' }, message: [{ type: 'text', data: { text: '第一条' } }] }] };
  assert.match(formatForward(flat), /\[阿明\] 第一条/);
  const nested = { data: { messages: [{ sender: { card: '小红' }, message: [{ type: 'text', data: { text: '第二条' } }] }] } };
  assert.match(formatForward(nested), /\[小红\] 第二条/);
});

test('formatForward says how many messages were forwarded', () => {
  const payload = {
    messages: [
      { sender: { nickname: 'A' }, message: [{ type: 'text', data: { text: '一' } }] },
      { sender: { nickname: 'B' }, message: [{ type: 'text', data: { text: '二' } }] },
    ],
  };
  const text = formatForward(payload);
  assert.match(text, /合并转发 · 2 条/);
  assert.match(text, /\[A\] 一/);
  assert.match(text, /\[B\] 二/);
});

test('formatForward copes with string content and card segments', () => {
  const payload = {
    messages: [
      { sender: { nickname: 'A' }, content: '字符串内容' },
      { sender: { nickname: 'B' }, message: [{ type: 'json', data: { summary: '[卡片]' } }] },
    ],
  };
  const text = formatForward(payload);
  assert.match(text, /\[A\] 字符串内容/);
  assert.match(text, /\[B\] \[卡片\]/);
});

test('formatForward truncates a long forward instead of flooding the prompt', () => {
  const messages = Array.from({ length: 60 }, (_, index) => ({
    sender: { nickname: '某人' },
    message: [{ type: 'text', data: { text: '第' + index + '句'.repeat(40) } }],
  }));
  const text = formatForward({ messages }, { maxMessages: 10, maxChars: 200 });
  assert.match(text, /已截断/);
  assert.ok(text.length < 600, 'the transcript stays bounded');
});

test('formatForward returns nothing for empty or malformed payloads', () => {
  assert.equal(formatForward(undefined), '');
  assert.equal(formatForward({}), '');
  assert.equal(formatForward({ messages: [] }), '');
});

test('fetchForwards joins several forwards and swallows failures', async () => {
  const calls = [];
  const client = {
    call: async (action, params) => {
      calls.push([action, params.id]);
      if (params.id === 'bad') throw new Error('nope');
      return { messages: [{ sender: { nickname: 'A' }, message: [{ type: 'text', data: { text: 'x' } }] }] };
    },
  };
  const lines = [];
  const { text } = await fetchForwards(client, [
    { type: 'forward', data: { id: 'ok' } },
    { type: 'forward', data: { id: 'bad' } },
  ], line => lines.push(line));
  assert.equal(calls.length, 2);
  assert.match(text, /\[A\] x/);
  assert.match(lines[0], /nope/);
});

test('fetchForwards skips the call when there is nothing to fetch', async () => {
  let called = false;
  const client = { call: async () => { called = true; return {}; } };
  assert.deepEqual(await fetchForwards(client, [{ type: 'text', data: {} }], () => {}), { text: '', images: [] });
  assert.equal(called, false);
});

test('a nested forward is expanded one level deeper', async () => {
  const payloads = {
    outer: {
      messages: [
        { sender: { nickname: 'A' }, message: [{ type: 'forward', data: { id: 'inner' } }] },
        { sender: { nickname: 'B' }, message: [{ type: 'text', data: { text: '外层第二句' } }] },
      ],
    },
    inner: { messages: [{ sender: { nickname: 'C' }, message: [{ type: 'text', data: { text: '内层内容' } }] }] },
  };
  const client = { call: async (_action, params) => payloads[params.id] };
  const lines = [];
  const { text } = await fetchForwards(client, [{ type: 'forward', data: { id: 'outer' } }], line => lines.push(line));
  assert.match(text, /合并转发 · 2 条/);
  assert.match(text, /\[A\] 转发了一段聊天记录/);
  assert.match(text, /【嵌套转发 · 1 条】/);
  assert.match(text, /  \[C\] 内层内容/);
  assert.match(text, /\[B\] 外层第二句/);
});

test('expansion stops after one nested layer', async () => {
  const payloads = {
    outer: { messages: [{ sender: { nickname: 'A' }, message: [{ type: 'forward', data: { id: 'inner' } }] }] },
    inner: { messages: [{ sender: { nickname: 'B' }, message: [{ type: 'forward', data: { id: 'deeper' } }] }] },
    deeper: { messages: [{ sender: { nickname: 'C' }, message: [{ type: 'text', data: { text: '第三层不该出现' } }] }] },
  };
  const calls = [];
  const client = { call: async (_action, params) => { calls.push(params.id); return payloads[params.id]; } };
  const { text } = await fetchForwards(client, [{ type: 'forward', data: { id: 'outer' } }], () => {});
  assert.equal(calls.includes('deeper'), false, 'the third level is never fetched');
  assert.equal(text.includes('第三层不该出现'), false);
});

test('a failing nested fetch keeps the outer content', async () => {
  const client = {
    call: async (_action, params) => {
      if (params.id === 'inner') throw new Error('gone');
      return {
        messages: [
          { sender: { nickname: 'A' }, message: [{ type: 'forward', data: { id: 'inner' } }] },
          { sender: { nickname: 'B' }, message: [{ type: 'text', data: { text: '仍然可读' } }] },
        ],
      };
    },
  };
  const lines = [];
  const { text } = await fetchForwards(client, [{ type: 'forward', data: { id: 'outer' } }], line => lines.push(line));
  assert.match(text, /\[B\] 仍然可读/);
  assert.match(lines.join(' '), /gone/);
});


test('images inside a forward are collected for the caller', async () => {
  const payload = {
    messages: [
      { sender: { nickname: 'A' }, message: [{ type: 'text', data: { text: '看图' } }, { type: 'image', data: { url: 'http://x/a.png' } }] },
      { sender: { nickname: 'B' }, message: [{ type: 'image', data: { url: '' } }] },
      { sender: { nickname: 'C' }, message: [{ type: 'image', data: { url: 'http://x/c.png' } }] },
    ],
  };
  const client = { call: async () => payload };
  const { text, images } = await fetchForwards(client, [{ type: 'forward', data: { id: 'x' } }], () => {});
  assert.match(text, /看图/);
  assert.deepEqual(images.map(image => image.data.url), ['http://x/a.png', 'http://x/c.png']);
});

test('images nested one level down are collected too', async () => {
  const payloads = {
    outer: { messages: [{ sender: { nickname: 'A' }, message: [{ type: 'forward', data: { id: 'inner' } }] }] },
    inner: { messages: [{ sender: { nickname: 'B' }, message: [{ type: 'image', data: { url: 'http://x/deep.png' } }] }] },
  };
  const client = { call: async (_action, params) => payloads[params.id] };
  const { images } = await fetchForwards(client, [{ type: 'forward', data: { id: 'outer' } }], () => {});
  assert.deepEqual(images.map(image => image.data.url), ['http://x/deep.png']);
});
