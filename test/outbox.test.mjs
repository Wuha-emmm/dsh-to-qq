import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionOf, mergeText, pruneQueue, CAPTION_LIMIT, MEDIA_TTL_MS } from '../src/bridge/outbox.js';

test('a short caption is kept as a label', () => {
  const short = '到主菜单了，烽火地带那一屏';
  assert.deepEqual(captionOf(short), { text: short, truncated: false });
});

test('a long caption is kept whole instead of being cut', () => {
  const long = '特勤处到了：技术中心 Lv.3、工作台 Lv.3、制药台 Lv.3、防具台 Lv.3，右边仓库 Lv.10、指挥中心 Lv.6';
  const result = captionOf(long);
  assert.equal(result.truncated, false);
  assert.equal(result.text, long);
  assert.ok(long.length > CAPTION_LIMIT);
});

test('an empty caption stays empty', () => {
  assert.deepEqual(captionOf('   '), { text: '', truncated: false });
  assert.deepEqual(captionOf(undefined), { text: '', truncated: false });
});

test('a caption the reply already contains is not repeated', () => {
  assert.equal(mergeText('到了特勤处，四个工位都 Lv.3', ['特勤处']), '到了特勤处，四个工位都 Lv.3');
});

test('a caption the reply does not contain is appended, not dropped', () => {
  assert.equal(
    mergeText('四个工位都 Lv.3，可以下单了', ['技术中心 Lv.3、工作台 Lv.3']),
    '四个工位都 Lv.3，可以下单了\n技术中心 Lv.3、工作台 Lv.3',
  );
});

test('without a reply every caption survives', () => {
  assert.equal(mergeText('', ['特勤处', '下一步点这里']), '特勤处\n下一步点这里');
  assert.equal(mergeText('   ', ['只有一条']), '只有一条');
  assert.equal(mergeText('', []), '');
});

test('a stale queued picture is dropped instead of leaking into a later turn', () => {
  const now = 5_000_000;
  const items = [
    { caption: '旧图', at: now - MEDIA_TTL_MS - 1 },
    { caption: '新图', at: now - 1000 },
    { caption: '没有时间戳' },
  ];
  const { fresh, stale } = pruneQueue(items, now);
  assert.deepEqual(stale.map(item => item.caption), ['旧图']);
  assert.deepEqual(fresh.map(item => item.caption), ['新图', '没有时间戳']);
});
