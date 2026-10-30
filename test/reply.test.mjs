import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldStaySilent } from '../src/bridge/reply.js';

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
