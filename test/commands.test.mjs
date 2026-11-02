import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, formatSessionList, extractSessions } from '../src/bridge/commands.js';

test('parseCommand recognizes Chinese and English commands', () => {
  assert.deepEqual(parseCommand('/暂停'), { name: 'pause', arg: '' });
  assert.deepEqual(parseCommand('  /切换 2 '), { name: 'switch', arg: '2' });
  assert.deepEqual(parseCommand('/list'), { name: 'list', arg: '' });
  assert.deepEqual(parseCommand('/新建 项目A'), { name: 'new', arg: '项目A' });
  assert.deepEqual(parseCommand('/记忆卡'), { name: 'card', arg: '' });
  assert.deepEqual(parseCommand('#sl'), { name: 'status', arg: '' });
  assert.deepEqual(parseCommand(' #SL '), { name: 'status', arg: '' });
});

test('parseCommand ignores ordinary text and unknown commands', () => {
  assert.equal(parseCommand('你好'), undefined);
  assert.equal(parseCommand('/unknown'), undefined);
  assert.equal(parseCommand('#chatter'), undefined);
  assert.equal(parseCommand('#未知命令'), undefined);
  assert.equal(parseCommand(''), undefined);
  assert.equal(parseCommand(undefined), undefined);
});

test('formatSessionList numbers sessions and explains the next step', () => {
  const text = formatSessionList([{ id: 'a', title: '部署脚本' }, { id: 'b' }], 5);
  assert.match(text, /1\. 部署脚本/);
  assert.match(text, /2\. （无标题）/);
  assert.match(text, /\/切换 序号/);
});

test('formatSessionList handles an empty list', () => {
  assert.equal(formatSessionList([]), '没有可切换的会话。');
});

test('extractSessions accepts the shapes the controller might return', () => {
  const rows = [{ id: 's1', title: 'A' }, { id: 's2' }];
  assert.deepEqual(extractSessions(rows).map(item => item.id), ['s1', 's2']);
  assert.deepEqual(extractSessions({ items: rows }).map(item => item.id), ['s1', 's2']);
  assert.deepEqual(extractSessions({ sessions: rows }).map(item => item.id), ['s1', 's2']);
  assert.deepEqual(extractSessions({ value: { items: rows } }).map(item => item.id), ['s1', 's2']);
  assert.deepEqual(extractSessions(null), []);
  assert.deepEqual(extractSessions({ items: [{ title: 'no id' }] }), []);
});

