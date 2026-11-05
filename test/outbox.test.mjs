import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionOf, mergeText, sameSpeech, pruneQueue, CAPTION_LIMIT, MEDIA_TTL_MS } from '../src/bridge/outbox.js';

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

test('a stale queued picture is dropped instead of leaking into a later turn', () => {  const now = 5_000_000;
  const items = [
    { caption: '旧图', at: now - MEDIA_TTL_MS - 1 },
    { caption: '新图', at: now - 1000 },
    { caption: '没有时间戳' },
  ];
  const { fresh, stale } = pruneQueue(items, now);
  assert.deepEqual(stale.map(item => item.caption), ['旧图']);
  assert.deepEqual(fresh.map(item => item.caption), ['新图', '没有时间戳']);
});

test('the same sentence said twice in different words counts once', () => {
  const reply = '页面上的金额才是准的；那个 8.8 块，是我拿 token 数按自己猜的单价（2 元/百万）算出来的，碰巧对上了 9 元。我这边只能看到 token，看不到账单。我能担保的只有这几个数：11 点到 13 点，31 轮、缓存命中 439 万、新输入 3.9 万、输出 5 千。';
  const caption = '不是，页面上的才是准的。我那 8.8 块是拿 token 数乘了个我猜的单价（2 元/百万）算出来的，正好撞上 9 元，纯属巧合。我这边只能看到 token，看不到账单，真金额以用量页为准。';
  assert.equal(sameSpeech(caption, reply), true);
  assert.equal(mergeText(reply, [caption]), reply);
});

test('two replies about different things both survive', () => {
  const reply = '改好了，提交 5e3b8b1，硬刷页就生效。';
  const caption = '另外面板里那个新消息浮标也可以在设置里关掉。';
  assert.equal(sameSpeech(caption, reply), false);
  assert.equal(mergeText(reply, [caption]), `${reply}\n${caption}`);
});

test('a short label is never mistaken for the reply', () => {
  assert.equal(sameSpeech('截图', '截图'), true);
  assert.equal(sameSpeech('截图', '截图在这里，工位已经领完了'), false);
});
