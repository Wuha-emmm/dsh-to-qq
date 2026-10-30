import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeQuestions, parseReply, extractPending } from '../src/bridge/questions.js';

const one = [{
  id: 'q1',
  question: '要不要继续？',
  options: [{ label: '继续' }, { label: '停一下', description: '先备份' }],
}];

test('describeQuestions numbers questions and letters options', () => {
  const text = describeQuestions(one);
  assert.match(text, /1\. 要不要继续？/);
  assert.match(text, /a\. 继续/);
  assert.match(text, /b\. 停一下 —— 先备份/);
});

test('parseReply maps a bare number on a single question', () => {
  assert.deepEqual(parseReply('2', one), { answers: [{ id: 'q1', selected: ['停一下'] }] });
});

test('parseReply maps question-number + letter', () => {
  assert.deepEqual(parseReply('1b', one), { answers: [{ id: 'q1', selected: ['停一下'] }] });
});

test('parseReply accepts an option label verbatim', () => {
  assert.deepEqual(parseReply('继续', one), { answers: [{ id: 'q1', selected: ['继续'] }] });
});

test('parseReply sends free text as a custom answer', () => {
  assert.deepEqual(parseReply('我自己写一个', one), { answers: [{ id: 'q1', selected: [], custom: '我自己写一个' }] });
});

test('parseReply handles multi-select letters', () => {
  const multi = [{ id: 'q2', question: '选几个', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }];
  assert.deepEqual(parseReply('1ac', multi), { answers: [{ id: 'q2', selected: ['A', 'C'] }] });
});

test('parseReply rejects empty input', () => {
  assert.equal(parseReply('   ', one), undefined);
  assert.equal(parseReply('1', []), undefined);
});

test('extractPending reads the projection shapes we might get', () => {
  const batch = { callId: 'call-1', questions: [{ id: 'q1', question: '?' }], state: 'open' };
  assert.deepEqual(extractPending({ pendingQuestions: [batch] }), [batch]);
  assert.deepEqual(extractPending({ projections: { pendingQuestions: [batch] } }), [batch]);
  assert.deepEqual(extractPending({}), []);
  assert.deepEqual(extractPending(null), []);
  assert.deepEqual(extractPending({ pendingQuestions: [{ callId: 5 }] }), []);
});
