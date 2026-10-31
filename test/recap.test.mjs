import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRecap } from '../src/context/recap.js';

test('recap keeps the newest messages in chronological order', () => {
  const rows = [
    { sender_name: 'C', sender_id: 3, text: 'third' },
    { sender_name: 'B', sender_id: 2, text: 'second' },
    { sender_name: 'A', sender_id: 1, text: 'first' },
  ];
  const recap = formatRecap(rows, { limit: 3 });
  assert.match(recap, /会话续接/);
  const body = recap.split('\n').slice(1);
  assert.deepEqual(body.map(line => line.split(':')[1].trim()), ['first', 'second', 'third']);
});

test('recap drops empty rows and respects the character budget', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    sender_name: `U${index}`,
    sender_id: index,
    text: `消息 ${index} `.repeat(12),
  }));
  const recap = formatRecap(rows, { limit: 40, maxChars: 400 });
  assert.ok(recap.length <= 400 + 120, `recap too long: ${recap.length}`);
  assert.equal(recap.includes('消息 0'), false, 'oldest rows are dropped first');
});

test('recap is empty when there is nothing to carry over', () => {
  assert.equal(formatRecap([]), '');
  assert.equal(formatRecap([{ text: '   ' }]), '');
});
