import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enoughSignal,
  buildImpressionPrompt,
  parseImpressionBullets,
  IMPRESSION_DEFAULTS,
} from '../src/memory/impressions.js';

const filler = count => Array.from({ length: count }, (_, index) => ({ text: `第${index}条发言内容足够长了` }));

test('a thin batch is not worth a summarizer run', () => {
  assert.equal(enoughSignal([], 10), false);
  assert.equal(enoughSignal([{ text: '哈哈哈' }, { text: '草' }], 800), false);
  assert.equal(enoughSignal(filler(3), 10), false, 'needs at least 20 distinct messages');
});

test('a substantive batch triggers', () => {
  assert.equal(enoughSignal(filler(25), 100), true);
});

test('the backfill gate is looser but still rejects noise', () => {
  // A quiet member: few characters, but several different things said.
  const quiet = Array.from({ length: 10 }, (_, index) => ({ text: '这是什么' + index }));
  assert.equal(enoughSignal(quiet, 300, 8), false, 'too few characters');
  const longer = Array.from({ length: 16 }, (_, index) => ({ text: '这是第' + index + '句关于项目进展和分工的详细说明' }));
  assert.equal(enoughSignal(longer, 300, 8), true);
  const wallOfText = [{ text: 'a'.repeat(2000) }];
  assert.equal(enoughSignal(wallOfText, 300, 8), false, 'one long message is not a personality');
});

test('the prompt carries previous impressions, the batch, and the rules', () => {
  const prompt = buildImpressionPrompt({
    name: '小明',
    qq: 10001,
    previous: [{ text: '在写桥接插件' }],
    batch: [{ scene: '群', text: '这个 bug 又出现了' }, { text: '私聊里说的话' }],
  });
  assert.match(prompt, /已有印象/);
  assert.match(prompt, /- 在写桥接插件/);
  assert.match(prompt, /- 群 这个 bug 又出现了/);
  assert.match(prompt, /- 私聊里说的话/);
  assert.match(prompt, /只输出条目/);
});

test('the prompt handles an empty impression list', () => {
  const prompt = buildImpressionPrompt({ name: 'A', qq: 1, previous: [], batch: [{ text: 'hi' }] });
  assert.match(prompt, /（空）/);
});

test('bullets are parsed, de-duplicated, and capped', () => {
  const text = ['- 在做 QQ 桥接', '- 在做 QQ 桥接', '• 不喜欢编造', '* 常发熊猫头表情包', '这不是条目'].join('\n');
  const notes = parseImpressionBullets(text, { at: 123, maxNotes: 2 });
  assert.deepEqual(notes, [
    { at: 123, text: '在做 QQ 桥接' },
    { at: 123, text: '不喜欢编造' },
  ]);
});

test('the character budget stops the list early', () => {
  const text = ['- ' + 'a'.repeat(30), '- ' + 'b'.repeat(30)].join('\n');
  const notes = parseImpressionBullets(text, { at: 1, budgetChars: 40 });
  assert.equal(notes.length, 1, 'the second bullet would exceed the budget');
});

test('garbage output yields no notes', () => {
  assert.deepEqual(parseImpressionBullets('模型开始解释自己了\n第二行'), []);
  assert.deepEqual(parseImpressionBullets(''), []);
});

test('defaults stay in a sane range', () => {
  assert.equal(IMPRESSION_DEFAULTS.every, 100);
  assert.ok(IMPRESSION_DEFAULTS.maxNotes <= 10);
  assert.ok(IMPRESSION_DEFAULTS.budgetChars <= 1000);
});




test('the strict pass rejects plain sentences', () => {
  assert.deepEqual(parseImpressionBullets('他在写一个桥接插件'), []);
});

test('the tolerant pass accepts numbered and bare lines', () => {
  const text = ['印象如下：', '1. 在写 QQ 桥接插件', '2、喜欢先看结论', '常发熊猫头表情包'].join('\n');
  const notes = parseImpressionBullets(text, { at: 1, allowBare: true });
  assert.deepEqual(notes.map(note => note.text), ['在写 QQ 桥接插件', '喜欢先看结论', '常发熊猫头表情包']);
});

test('meta lines are still skipped even in tolerant mode', () => {
  const text = ['以下是整理后的印象：', '要求：每条不超过 30 字', '- 在写桥接插件'].join('\n');
  const notes = parseImpressionBullets(text, { at: 1, allowBare: true });
  assert.deepEqual(notes.map(note => note.text), ['在写桥接插件']);
});

