import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge/runtime.js';

/** A config with no admins: every message is ignored, which keeps handle() short. */
const CONFIG = {
  connection: { botUin: 10002 },
  access: {
    admins: [],
    blockedWords: [],
    strangerPolicy: 'ignore',
    groupMode: 'blacklist',
    groups: [],
    mentionOnly: true,
  },
  limits: { memberDaily: 0, groupDaily: 0, userPerMinute: 60, replyDelayMs: 0, jitterMs: 0, maxDelayMs: 0, queueMax: 5, concurrency: 1, turnTimeoutMs: 1000 },
  conversation: { groupHistory: 9, groupCharCap: 600, groupPrivacy: true },
  memory: { autoNoteEvery: 0 },
  voice: { enabled: false },
  stickers: { enabled: false },
};

function makeBridge() {
  const bridge = new Bridge({
    store: { get: () => CONFIG },
    log: () => {},
    driver: { ask: async () => ({ sessionId: 's', text: '' }) },
  });
  bridge.archive = { write: () => {}, insert: () => {}, search: () => [] };
  return bridge;
}

const DM = {
  post_type: 'message',
  message_type: 'private',
  self_id: 10002,
  user_id: 10001,
  message_id: 1,
  time: Math.floor(Date.now() / 1000),
  message: [{ type: 'text', data: { text: '在吗' } }],
  sender: { user_id: 10001, nickname: 'test' },
};

test('handle() reads config before the self_id pin (regression: TDZ crash)', async () => {
  const bridge = makeBridge();
  // A foreign self_id returns right after the pin block, which is exactly the
  // line that used to read `config` before its declaration and kill the host.
  await bridge.handle({ ...DM, self_id: 99999 });
  assert.equal(bridge.counters.ignored, 1);
  assert.equal(bridge.selfId, 0, 'a foreign event must not claim the identity');
});

test('handle() accepts the matching bot account and records it', async () => {
  const bridge = makeBridge();
  await bridge.handle(DM);
  assert.equal(bridge.selfId, 10002);
  assert.equal(bridge.counters.events, 1);
  assert.equal(bridge.counters.ignored, 1, 'a stranger under "ignore" policy is dropped');
});
