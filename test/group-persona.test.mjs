import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_PERSONA_USAGE,
  resolveGroupPersonaTarget,
  renderGroupPersonaBlock,
} from '../src/bridge/group-persona.js';

test('resolveGroupPersonaTarget uses the current group and strips its own number', () => {
  assert.deepEqual(
    resolveGroupPersonaTarget({ arg: '', kind: 'group', groupId: 661526815 }),
    { groupId: 661526815, text: '' },
  );
  assert.deepEqual(
    resolveGroupPersonaTarget({ arg: '661526815 本群说话别客套', kind: 'group', groupId: 661526815 }),
    { groupId: 661526815, text: '本群说话别客套' },
  );
  assert.deepEqual(
    resolveGroupPersonaTarget({ arg: '本群说话别客套', kind: 'group', groupId: 661526815 }),
    { groupId: 661526815, text: '本群说话别客套' },
  );
});

test('resolveGroupPersonaTarget requires a group number in a private chat', () => {
  assert.deepEqual(
    resolveGroupPersonaTarget({ arg: '661526815 本群说话别客套', kind: 'dm' }),
    { groupId: 661526815, text: '本群说话别客套' },
  );
  assert.deepEqual(
    resolveGroupPersonaTarget({ arg: '本群说话别客套', kind: 'dm' }),
    { groupId: 0, text: '本群说话别客套' },
  );
  assert.deepEqual(
    resolveGroupPersonaTarget({ arg: '', kind: 'dm' }),
    { groupId: 0, text: '' },
  );
});

test('renderGroupPersonaBlock yields to a personal persona', () => {
  const text = '本群说话温柔一点';
  assert.match(renderGroupPersonaBlock({ text }), /【本群默认人设】/);
  assert.match(renderGroupPersonaBlock({ text }), /本群说话温柔一点/);
  assert.equal(renderGroupPersonaBlock({ text, hasOwnPersona: true }), '');
});

test('renderGroupPersonaBlock leaves a tombstone after a clear', () => {
  const block = renderGroupPersonaBlock({ text: '', clearedAt: 123 });
  assert.match(block, /管理员已清除本群的默认人设/);
  assert.equal(renderGroupPersonaBlock({ text: '', clearedAt: 0 }), '');
});

test('GROUP_PERSONA_USAGE documents the private-chat form', () => {
  assert.match(GROUP_PERSONA_USAGE, /私聊.*群号/);
  assert.match(GROUP_PERSONA_USAGE, /\/群人设 清空/);
});
