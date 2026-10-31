import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionOf, mergeText, CAPTION_LIMIT } from '../src/bridge/outbox.js';

test('a short caption is kept as a label', () => {
  const short = '到主菜单了，烽火地带那一屏';
  assert.deepEqual(captionOf(short), { text: short, truncated: false });
});

test('a long caption is cut at the limit', () => {
  const long = '特勤处到了：技术中心 Lv.3、工作台 Lv.3、制药台 Lv.3、防具台 Lv.3，右边仓库 Lv.10、指挥中心 Lv.6';
  const result = captionOf(long);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, CAPTION_LIMIT + 1);
  assert.ok(result.text.endsWith('…'));
  assert.equal(long.startsWith(result.text.slice(0, -1)), true);
});

test('an empty caption stays empty', () => {
  assert.deepEqual(captionOf('   '), { text: '', truncated: false });
  assert.deepEqual(captionOf(undefined), { text: '', truncated: false });
});

test('the reply supersedes the captions', () => {
  assert.equal(mergeText('到了特勤处，四个工位都 Lv.3', ['特勤处']), '到了特勤处，四个工位都 Lv.3');
});

test('without a reply the captions are the message', () => {
  assert.equal(mergeText('', ['特勤处', '下一步点这里']), '特勤处 下一步点这里');
  assert.equal(mergeText('   ', ['只有一条']), '只有一条');
  assert.equal(mergeText('', []), '');
});
