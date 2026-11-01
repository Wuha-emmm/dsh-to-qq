import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InjectionTracker, entrySignature, textHash } from '../src/context/injection.js';

test('a fixed block is sent once and re-sent only when it changes', () => {
  const tracker = new InjectionTracker();
  assert.equal(tracker.fixed('card', '人设 A'), '人设 A');
  assert.equal(tracker.fixed('card', '人设 A'), '', 'unchanged block is skipped');
  assert.equal(tracker.fixed('card', '人设 B'), '人设 B', 'changed block is sent again');
  assert.equal(tracker.fixed('card', ''), '', 'an empty block never sends');
  assert.equal(tracker.stats.skipped, '人设 A'.length);
});

test('each slot is independent', () => {
  const tracker = new InjectionTracker();
  tracker.fixed('rules', '规则');
  assert.equal(tracker.fixed('stickers', '表情'), '表情');
  assert.equal(tracker.fixed('rules', '规则'), '');
  assert.equal(tracker.fixed('stickers', '表情'), '');
});

test('a card is tracked per sender, not per scene', () => {
  const tracker = new InjectionTracker();
  assert.equal(tracker.fixed('card', 'A 卡', 11), 'A 卡');
  assert.equal(tracker.fixed('card', 'B 卡', 22), 'B 卡');
  assert.equal(tracker.fixed('card', 'A 卡', 11), '', 'alternating speakers must not re-send A');
  assert.equal(tracker.fixed('card', 'B 卡', 22), '', 'nor B');
  assert.equal(tracker.fixed('card', 'A 卡（新）', 11), 'A 卡（新）', 'A changed, only A re-sends');
  assert.equal(tracker.fixed('card', 'B 卡', 22), '', 'B untouched');
});

test('delta returns only messages the tracker has not seen', () => {
  const tracker = new InjectionTracker();
  const first = [{ time: 1, senderId: 2, text: 'a' }];
  const second = [{ time: 3, senderId: 4, text: 'b' }];
  assert.deepEqual(tracker.delta(first), first);
  assert.deepEqual(tracker.delta(first), [], 'already injected');
  assert.deepEqual(tracker.delta([...first, ...second]), second);
  assert.deepEqual(tracker.delta(second), []);
});

test('delta keeps identical text from different senders distinct', () => {
  const tracker = new InjectionTracker();
  const a = { time: 1, senderId: 1, text: '在吗' };
  const b = { time: 1, senderId: 2, text: '在吗' };
  assert.deepEqual(tracker.delta([a]), [a]);
  assert.deepEqual(tracker.delta([a, b]), [b]);
  assert.equal(entrySignature(a) === entrySignature(b), false);
});

test('the seen set is trimmed so a long session cannot grow forever', () => {
  const tracker = new InjectionTracker({ seenLimit: 50 });
  for (let index = 0; index < 200; index += 1) {
    tracker.delta([{ time: index, senderId: 1, text: `m${index}` }]);
  }
  assert.ok(tracker.seen.size <= 50);
});

test('textHash is stable and distinguishes nearby strings', () => {
  assert.equal(textHash('同样的文本'), textHash('同样的文本'));
  assert.notEqual(textHash('文本 A'), textHash('文本 B'));
  assert.equal(textHash(''), textHash(''));
});
