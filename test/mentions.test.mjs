import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplySegments, memberNames } from '../src/bridge/mentions.js';

const members = memberNames([
  { user_id: 1001, card: '蓝莓', nickname: 'blue' },
  { user_id: 1002, card: '', nickname: '大虎鲸' },
]);

test('a known name becomes an at segment', () => {
  const segments = buildReplySegments('@蓝莓 你看看这个', members);
  assert.deepEqual(segments, [
    { type: 'at', data: { qq: '1001' } },
    { type: 'text', data: { text: ' 你看看这个' } },
  ]);
});

test('a nickname and a raw number both resolve', () => {
  const segments = buildReplySegments('@大虎鲸 @1002 一起', members);
  assert.deepEqual(segments.map(segment => segment.type), ['at', 'text', 'at', 'text']);
  assert.equal(segments[0].data.qq, '1002');
  assert.equal(segments[2].data.qq, '1002');
});

test('@全体成员 becomes the all target', () => {
  assert.deepEqual(buildReplySegments('@全体成员 开会', members)[0], { type: 'at', data: { qq: 'all' } });
});

test('an unknown name stays literal text', () => {
  const segments = buildReplySegments('@路人甲 你好', members);
  assert.deepEqual(segments, [{ type: 'text', data: { text: '@路人甲 你好' } }]);
});

test('a reply without mentions is one text segment', () => {
  assert.deepEqual(buildReplySegments('普通回复', members), [{ type: 'text', data: { text: '普通回复' } }]);
});

test('email-like text is not mistaken for a mention', () => {
  const segments = buildReplySegments('发到 a@b.com 吧', members);
  assert.deepEqual(segments, [{ type: 'text', data: { text: '发到 a@b.com 吧' } }]);
});

test('memberNames keeps cards, nicknames and raw numbers', () => {
  assert.equal(members.get('蓝莓'), 1001);
  assert.equal(members.get('blue'), 1001);
  assert.equal(members.get('1002'), 1002);
});
