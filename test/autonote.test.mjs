import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueForAutoNote, autoNotePrompt, DEFAULT_AUTO_NOTE_EVERY } from '../src/memory/autonote.js';

test('the nudge fires on every Nth turn', () => {
  assert.equal(dueForAutoNote(8, 8), true);
  assert.equal(dueForAutoNote(16, 8), true);
  assert.equal(dueForAutoNote(7, 8), false);
  assert.equal(dueForAutoNote(9, 8), false);
});

test('a cadence of zero or less disables the nudge', () => {
  assert.equal(dueForAutoNote(8, 0), false);
  assert.equal(dueForAutoNote(8, -3), false);
  assert.equal(dueForAutoNote(1, 1), true);
});

test('nonsense turn numbers never fire', () => {
  assert.equal(dueForAutoNote(0, 8), false);
  assert.equal(dueForAutoNote(-4, 8), false);
  assert.equal(dueForAutoNote(2.5, 8), false);
});

test('the reminder tells the model what not to write', () => {
  const text = autoNotePrompt();
  assert.match(text, /memory_note/);
  assert.match(text, /不要记/);
  assert.match(text, /人设/);
});

test('the default cadence is sane', () => {
  assert.equal(DEFAULT_AUTO_NOTE_EVERY, 8);
});
