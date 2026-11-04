import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEnvelopeDebris, shouldStaySilent } from '../src/bridge/reply.js';

test('any text is dropped once a card went out', () => {
  assert.equal(shouldStaySilent('', { cardSent: true }), true);
  assert.equal(shouldStaySilent('已发送', { cardSent: true }), true);
  assert.equal(
    shouldStaySilent('图里上半段是我需要遵守的说话方式，下半段是我从聊天里记下的印象，你可以用 /人设 改上面那部分。', { cardSent: true }),
    true,
    'a long explanation is still dropped: the image is the answer',
  );
});

test('without a card every reply is sent', () => {
  assert.equal(shouldStaySilent('', { cardSent: false }), false);
  assert.equal(shouldStaySilent('好的', { cardSent: false }), false);
  assert.equal(shouldStaySilent('出了点问题，图没发出去', { cardSent: false }), false);
});

test('recognises the leftovers actually seen in the group', () => {
  const seen = [
    '</anthml>',
    '</antml>',
    '<</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>',
    '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>',
    '</antmlinvoke>\n</antmlfunction_calls>',
    '</antml:function_calls>',
    '  <｜｜DSML｜｜ tool_calls>\n</｜｜DSML｜｜ tool_calls>  ',
    '<｜｜DSML｜｜ parameter name="text">',
  ];
  for (const text of seen) {
    assert.equal(isEnvelopeDebris(text), true, text);
  }
});

test('keeps prose and emoticons that merely resemble markup', () => {
  const prose = [
    '别输出 </antml:function_calls> 这种标签。',
    '参数 parameter 到底是什么意思？',
    '它调用 invoke 之后就没反应了。',
    '今天天气不错，出去走走？',
    '<3 你说得对',
    '<div>这个标签是正常的</div>',
    '',
    '   ',
  ];
  for (const text of prose) {
    assert.equal(isEnvelopeDebris(text), false, text);
  }
});

test('ignores anything long enough to be a real answer', () => {
  const long = `${'标签是什么？'.repeat(40)} </antmlinvoke>`;
  assert.equal(isEnvelopeDebris(long), false);
});
