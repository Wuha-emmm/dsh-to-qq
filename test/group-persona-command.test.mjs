import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { defaults } from '../src/config/defaults.js';

const GROUP_ID = 661526815;

async function harness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-persona-'));
  const config = defaults();
  config.connection.botUin = 10002;
  config.access.admins = [{ qq: 10001 }];
  config.access.mentionOnly = false;
  config.access.groupMode = 'blacklist';
  config.access.groups = [];
  const memory = new MemoryStore(join(dir, 'memory.json'));
  await memory.load();
  const calls = [];
  const bridge = new Bridge({ store: { get: () => config }, memory, log: () => {}, stateDir: dir, driver: options.driver });
  bridge.client = {
    call: async (action, params) => {
      calls.push({ action, params });
      return { message_id: 1 };
    },
  };
  return { dir, config, memory, calls, bridge };
}

let nextMessageId = 0;

function groupEvent(text, userId = 10001) {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 10002,
    group_id: GROUP_ID,
    user_id: userId,
    message_id: ++nextMessageId,
    time: 1793374000,
    sender: { user_id: userId, nickname: '小明', card: '群名片' },
    message: [{ type: 'text', data: { text } }],
  };
}

function dmEvent(text, userId = 10001) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: 10002,
    user_id: userId,
    message_id: ++nextMessageId,
    time: 1793374000,
    sender: { user_id: userId, nickname: '小明' },
    message: [{ type: 'text', data: { text } }],
  };
}

const replyText = calls => calls.at(-1)?.params?.message?.[0]?.data?.text ?? '';

test('an administrator can set, show, and clear the group persona', async () => {
  const { dir, memory, calls, bridge } = await harness();
  try {
    await bridge.handle(groupEvent('/群人设 本群说话温柔一点'));
    assert.match(replyText(calls), /已设置群 661526815 的默认人设（8 字）/);
    assert.equal(memory.groupPersona(GROUP_ID).text, '本群说话温柔一点');

    await bridge.handle(groupEvent('/群人设'));
    assert.match(replyText(calls), /本群说话温柔一点/);
    assert.match(replyText(calls), /修改：\/群人设 内容/);

    await bridge.handle(groupEvent('/群人设 清空'));
    assert.match(replyText(calls), /已清除群 661526815 的默认人设/);
    assert.equal(memory.groupPersona(GROUP_ID).text, '');
    assert.ok(memory.groupPersona(GROUP_ID).clearedAt > 0);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a private chat needs the group number', async () => {
  const { dir, config, memory, calls, bridge } = await harness();
  try {
    await bridge.handle(dmEvent('/群人设 还没带群号'));
    assert.match(replyText(calls), /私聊里请带上群号/);
    assert.equal(memory.groupPersona(GROUP_ID), null);

    await bridge.handle(dmEvent(`/群人设 ${GROUP_ID} 私聊里设置`));
    assert.match(replyText(calls), /已设置群 661526815 的默认人设/);
    assert.equal(memory.groupPersona(GROUP_ID).text, '私聊里设置');
    assert.equal(config.access.admins.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a non-administrator cannot change the group persona', async () => {
  const { dir, config, memory, calls, bridge } = await harness();
  try {
    config.access.admins = [];
    await bridge.handle(groupEvent('/群人设 普通人不能改'));
    assert.match(replyText(calls), /仅管理员可以修改本群默认人设/);
    assert.equal(memory.groupPersona(GROUP_ID), null);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the group prompt anchors the current speaker, not the last card', async () => {
  const prompts = [];
  const driver = {
    ask: async args => {
      prompts.push(String(args.text));
      return { text: '收到', usage: null };
    },
  };
  const { dir, memory, bridge } = await harness({ driver });
  try {
    await memory.setPersona(1813714484, '你是[鱼]，不苟言笑，从语气里分不清情感。');
    await memory.setGroupPersona(GROUP_ID, '群里说话简短。');
    await bridge.handle(groupEvent('你好', 10003));

    const prompt = prompts.at(-1) ?? '';
    assert.match(prompt, /【本轮人设】/);
    assert.match(prompt, /没有个人人设/);
    assert.match(prompt, /群里说话简短/);
    assert.doesNotMatch(prompt, /不苟言笑/);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
