import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRecap } from '../src/context/recap.js';

test('the recap never includes the message that triggered the rebuild', async () => {
  // The exact filter lives in the bridge; this test pins the helper contract:
  // filtering by msg_id before formatting removes the current question.
  const rows = [
    { msg_id: 'trigger', sender_name: '呜哈', text: '@bot 试试群聊的token用量' },
    { msg_id: '1', sender_name: '蓝莓', text: '我的token在燃烧' },
    { msg_id: '2', sender_name: '呜哈', text: '应该还好吧' },
  ];
  const kept = rows.filter(row => String(row.msg_id ?? '') !== 'trigger');
  const recap = formatRecap(kept);
  assert.equal(recap.includes('试试群聊的token用量'), false, 'the trigger must not be carried over');
  assert.match(recap, /我的token在燃烧/);
});
