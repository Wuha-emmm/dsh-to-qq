import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge/runtime.js';

/** A private message from the administrator. */
function adminMessage(text) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: 10002,
    user_id: 10001,
    message_id: 7,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: 10001, nickname: 'tester' },
  };
}

function makeBridge() {
  const calls = [];
  const bridge = new Bridge({
    store: {
      get: () => ({
        connection: { botUin: 10002 },
        access: { admins: [{ qq: 10001 }], groupMode: 'all', groups: [], mentionOnly: false },
        limits: {},
        conversation: {},
        memory: {},
        stickers: {},
        output: {},
        safety: { toolGrantMinutes: 15 },
      }),
    },
    log: () => {},
    stateDir: '',
    approvals: { grantTools: () => ({ tools: ['pwsh'] }), pendingOf: () => undefined },
  });
  bridge.client = {
    call: async (action, params) => {
      calls.push({ action, params });
      return {};
    },
  };
  bridge.driver = { ask: async () => ({ text: '文件在这儿，老爹。', sessionId: 's1' }) };
  return { bridge, calls };
}

test('the resumed turn flushes the file it queued instead of leaking it', async () => {
  const { bridge, calls } = makeBridge();
  // The model queued a captioned file while the turn was waiting for approval.
  bridge.queueMedia('dm:10001', { caption: 'v4 剧本', image: '', file: 'E:\\DSH-herself\\delta-script-v4.md' });
  await bridge.handle(adminMessage('/全放行'));

  const uploads = calls.filter(call => call.action === 'upload_private_file');
  assert.equal(uploads.length, 1, 'the file goes out once, with the resumed reply');
  assert.equal(uploads[0].params.name, 'delta-script-v4.md');

  const texts = calls
    .filter(call => call.action === 'send_private_msg')
    .map(call => call.params.message.map(segment => segment.data?.text ?? segment.type).join(''));
  assert.equal(texts.filter(text => text.includes('文件在这儿')).length, 1, 'the reply goes out once');
  assert.equal(texts.filter(text => text.includes('v4 剧本')).length, 1, 'the caption rides along once');
  assert.equal(bridge.mediaQueue.size, 0, 'nothing is left for the next turn');
});
