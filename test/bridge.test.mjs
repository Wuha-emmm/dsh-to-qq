import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenSegments, normalizeEvent, chunkText } from '../src/bridge/events.js';
import { admit, tierOf, mayRead, mayWrite } from '../src/policy/tiers.js';
import { defaults, mergeConfig } from '../src/config/defaults.js';

/** Build a minimal group message event. */
const groupEvent = (overrides = {}) => ({
  post_type: 'message',
  message_type: 'group',
  self_id: 10002,
  group_id: 20001,
  user_id: 10001,
  message_id: 1273193941,
  time: 1793374000,
  sender: { user_id: 10001, nickname: '小明', card: '群名片' },
  message: [{ type: 'text', data: { text: '你好' } }],
  ...overrides,
});

/** Build a minimal private message event. */
const dmEvent = (overrides = {}) => ({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  self_id: 10002,
  user_id: 10001,
  message_id: 42,
  time: 1793374000,
  sender: { user_id: 10001, nickname: '小明' },
  message: [{ type: 'text', data: { text: '在吗' } }],
  ...overrides,
});

test('flattenSegments keeps text, marks mentions, and labels media', () => {
  const result = flattenSegments([
    { type: 'at', data: { qq: '10002' } },
    { type: 'text', data: { text: ' 看看这个 ' } },
    { type: 'image', data: { file: 'a.png' } },
    { type: 'face', data: { id: '1' } },
  ], 10002);
  assert.equal(result.mentionsBot, true);
  assert.equal(result.text, '@10002 看看这个 [图片][表情]');
});

test('flattenSegments treats at-all distinctly and captures replies', () => {
  const result = flattenSegments([
    { type: 'at', data: { qq: 'all' } },
    { type: 'reply', data: { id: '99' } },
    { type: 'text', data: { text: '开会了' } },
  ], 10002);
  assert.equal(result.mentionsAll, true);
  assert.equal(result.mentionsBot, false);
  assert.equal(result.replyTo, '99');
  assert.equal(result.text, '@全体成员开会了');
});

test('normalizeEvent ignores non-message and self-authored events', () => {
  assert.equal(normalizeEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), undefined);
  assert.equal(normalizeEvent({ post_type: 'notice', notice_type: 'group_recall' }), undefined);
  assert.equal(normalizeEvent(dmEvent({ sub_type: 'self' })), undefined);
  assert.equal(normalizeEvent(dmEvent({ user_id: 10002 })), undefined);
  assert.equal(normalizeEvent(null), undefined);
});

test('normalizeEvent produces scene keys and display names', () => {
  const group = normalizeEvent(groupEvent());
  assert.equal(group.scene, 'group:20001');
  assert.equal(group.groupId, 20001);
  assert.equal(group.senderName, '群名片');
  assert.equal(group.key, '10002:1273193941');

  const dm = normalizeEvent(dmEvent());
  assert.equal(dm.scene, 'dm:10001');
  assert.equal(dm.groupId, undefined);
  assert.equal(dm.senderName, '小明');
});

test('tierOf decides by sender, not by scene', () => {
  const config = mergeConfig({ access: { admins: [{ qq: 10001, name: 'me', addedAt: 0 }] } });
  const adminDm = normalizeEvent(dmEvent());
  const adminGroup = normalizeEvent(groupEvent());
  const strangerGroup = normalizeEvent(groupEvent({ user_id: 999, sender: { user_id: 999, nickname: '路人' } }));

  assert.equal(tierOf(adminDm, config.access), 'owner');
  assert.equal(tierOf(adminGroup, config.access), 'owner-group');
  assert.equal(tierOf(strangerGroup, config.access), 'member-group');
  assert.equal(mayWrite('owner'), true);
  assert.equal(mayWrite('owner-group'), false);
  assert.equal(mayRead('owner-group'), true);
  assert.equal(mayRead('member-group'), false);
});

test('admit honours private policy and group gating', () => {
  const config = mergeConfig({
    access: {
      admins: [{ qq: 10001, name: 'me', addedAt: 0 }],
      groupMode: 'whitelist',
      groups: [],
      mentionOnly: true,
      strangerPolicy: 'ignore',
    },
  });
  const adminDm = normalizeEvent(dmEvent());
  const strangerDm = normalizeEvent(dmEvent({ user_id: 555, sender: { user_id: 555, nickname: 'x' } }));
  const adminNoMention = normalizeEvent(groupEvent());
  const adminMention = normalizeEvent(groupEvent({ message: [{ type: 'at', data: { qq: '10002' } }, { type: 'text', data: { text: ' 在吗' } }] }));

  assert.deepEqual(admit(adminDm, config), { accepted: true });
  assert.equal(admit(strangerDm, config).reason, 'stranger-ignored');
  assert.equal(admit(adminNoMention, config).reason, 'group-not-whitelisted');

  const withGroup = mergeConfig({ access: { ...config.access, groups: [20001] } });
  assert.equal(admit(adminNoMention, withGroup).reason, 'not-mentioned');
  assert.deepEqual(admit(adminMention, withGroup), { accepted: true });
});

test('admit drops blocked words', () => {
  const config = mergeConfig({ access: { blockedWords: ['广告'] } });
  const message = normalizeEvent(dmEvent({ message: [{ type: 'text', data: { text: '这是广告' } }] }));
  assert.equal(admit(message, config).reason, 'blocked-word');
});

test('chunkText splits on lines and respects the limit', () => {
  const text = Array.from({ length: 40 }, (_, index) => `第 ${index} 行`).join('\n');
  const chunks = chunkText(text, 40);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 40, `chunk too long: ${chunk.length}`);
  assert.equal(chunks.join('\n'), text);
  assert.deepEqual(chunkText('short', 40), ['short']);
});

test('defaults keep the documented runtime shape', () => {
  assert.equal(defaults().limits.replyDelayMs, 2000);
});

