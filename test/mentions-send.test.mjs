import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge/runtime.js';

function makeBridge(calls) {
  const bridge = new Bridge({
    store: { get: () => ({ connection: { botUin: 0 }, access: { admins: [] }, limits: {}, conversation: {}, memory: {}, stickers: {}, output: {} }) },
    log: () => {},
    stateDir: '',
  });
  bridge.client = {
    call: async (action, params) => {
      calls.push({ action, params });
      if (action === 'get_group_member_list') return [{ user_id: 1001, card: '蓝莓', nickname: 'blue' }];
      return {};
    },
  };
  return bridge;
}

const groupMessage = { kind: 'group', scene: 'group:20001', groupId: 20001, peerId: 20001, selfId: 10002, senderId: 10001, senderName: '小明', messageId: 1, segments: [] };

test('a group reply mentions someone with a real at segment', async () => {
  const calls = [];
  const bridge = makeBridge(calls);
  await bridge.sendText(groupMessage, '@蓝莓 你来看看');
  const reply = calls.find(call => call.action === 'send_group_msg');
  assert.deepEqual(reply.params.message[0], { type: 'at', data: { qq: '1001' } });
  assert.equal(reply.params.message[1].type, 'text');
});

test('a private reply never gets at segments', async () => {
  const calls = [];
  const bridge = makeBridge(calls);
  await bridge.sendText({ ...groupMessage, kind: 'dm', scene: 'dm:10001', peerId: 10001 }, '@蓝莓 你好');
  const reply = calls.find(call => call.action === 'send_private_msg');
  assert.equal(reply.params.message.length, 1);
  assert.equal(reply.params.message[0].type, 'text');
  assert.equal(reply.params.message[0].data.text, '@蓝莓 你好');
});
