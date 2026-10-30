import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SceneBuffer, renderContext, clock } from '../src/context/buffer.js';
import { GuestRegistry, TIER_TOOLS, installTierRestriction } from '../src/policy/restrictions.js';

/** Build one buffer entry. */
const entry = (messageId, text, extra = {}) => ({
  senderId: 10001,
  senderName: '小明',
  text,
  time: 1793374000 + messageId,
  messageId,
  mentionsBot: false,
  ...extra,
});

test('SceneBuffer keeps the newest messages and evicts the oldest', () => {
  const buffer = new SceneBuffer(3);
  for (const id of [1, 2, 3, 4, 5]) buffer.push('group:1', entry(id, `m${id}`));
  assert.deepEqual(buffer.recent('group:1').map(item => item.messageId), [3, 4, 5]);
  assert.deepEqual(buffer.recent('group:1', 2).map(item => item.messageId), [4, 5]);
  assert.equal(buffer.recent('group:missing').length, 0);
});

test('SceneBuffer finds a quoted message and clears per scene', () => {
  const buffer = new SceneBuffer(5);
  buffer.push('group:1', entry(7, '被引用的话'));
  buffer.push('group:1', entry(8, '引用它'));
  assert.equal(buffer.find('group:1', '7').text, '被引用的话');
  assert.equal(buffer.find('group:1', 7).text, '被引用的话');
  assert.equal(buffer.find('group:1', '404'), undefined);
  buffer.clear('group:1');
  assert.equal(buffer.recent('group:1').length, 0);
});

test('renderContext marks mentions, prefixes quotes, and respects the budget', () => {
  const entries = [
    entry(1, '今天天气不错'),
    entry(2, '这外壳 ui 卡卡的'),
    entry(3, '@我 帮我看看这个', { mentionsBot: true }),
  ];
  const block = renderContext({ entries, quoted: '小明: 昨天那张图', maxChars: 5000 });
  assert.match(block, /【群聊上下文】/);
  assert.match(block, /\[@我\]/);
  assert.match(block, /【被引用的消息】小明: 昨天那张图/);
  assert.match(block, /今天天气不错/);

  const tight = renderContext({ entries, maxChars: 60 });
  assert.ok(!tight.includes('今天天气不错'), 'oldest lines must be dropped first');
  assert.match(tight, /帮我看看这个/);

  assert.equal(renderContext({ entries: [], maxChars: 100 }), '');
});

test('SceneBuffer.merge dedupes history, keeps order, and caps the window', () => {
  const buffer = new SceneBuffer(4);
  buffer.push('group:1', entry(10, '现在'));
  buffer.merge('group:1', [entry(9, '刚才'), entry(8, '更早'), entry(10, '现在')]);
  assert.deepEqual(buffer.recent('group:1').map(item => item.messageId), [8, 9, 10]);

  buffer.merge('group:1', [entry(7, '最旧'), entry(11, '最新')]);
  assert.deepEqual(buffer.recent('group:1').map(item => item.messageId), [8, 9, 10, 11]);
});

test('clock renders HH:mm in local time', () => {
  assert.match(clock(1793374000), /^\d{2}:\d{2}$/);
});

test('GuestRegistry tracks expected sessions without consuming them', () => {
  const guests = new GuestRegistry([['session-a', 'member']]);
  assert.equal(guests.tierOf('session-a'), 'member');
  guests.expect('session-b', 'owner-group');
  assert.equal(guests.tierOf('session-b'), 'owner-group');
  assert.deepEqual(guests.toJSON(), { 'session-a': 'member', 'session-b': 'owner-group' });
});

test('installTierRestriction intersects the allowlist with registered tools', () => {
  const registered = ['read', 'grep', 'web_search', 'qq_send', 'unrelated'];
  const restrictions = [];
  const disposers = [];
  const agent = {
    id: 'session-g',
    ctx: {
      // The registry refuses a context-global restriction, so the agent's own
      // scoped tools service must carry the call.
      tools: {
        restrict: filter => {
          restrictions.push(filter);
          return () => {};
        },
      },
      effect: callback => {
        disposers.push(callback());
        return () => {};
      },
    },
  };
  const tools = { schemas: () => registered.map(name => ({ name })) };

  installTierRestriction({ tools, agent }, 'member');
  assert.deepEqual(restrictions[0], { allow: ['web_search', 'qq_send'] });

  installTierRestriction({ tools, agent }, 'owner-group');
  assert.deepEqual(restrictions[1].allow, ['read', 'grep', 'web_search', 'qq_send']);
  assert.equal(disposers.length, 2);
});

test('installTierRestriction refuses to run without a confinement', () => {
  const tools = { schemas: () => [], restrict: () => () => {} };
  assert.throws(
    () => installTierRestriction({ tools, agent: { id: 'x', ctx: { effect: () => {} } } }, 'member'),
    /no tier tool/,
  );
  assert.throws(
    () => installTierRestriction({ tools, agent: { id: 'x' } }, 'member'),
    /exposes no context/,
  );
  assert.throws(() => installTierRestriction({ tools, agent: { id: 'x', ctx: {} } }, 'nope'), /unknown tier/);

  const visible = { schemas: () => [{ name: 'read' }, { name: 'web_search' }] };
  assert.throws(
    () => installTierRestriction({ tools: visible, agent: { id: 'x', ctx: { effect: () => {} } } }, 'member'),
    /no scoped tools service/,
  );
});

test('owner tier has no restriction entry', () => {
  assert.equal(TIER_TOOLS.owner, undefined);
  assert.equal(TIER_TOOLS['owner-group'].includes('write'), false);
});
