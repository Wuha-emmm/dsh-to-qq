import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequestEvent, describeRequest } from '../src/bridge/requests.js';
import { describeCard } from '../src/bridge/cards.js';

test('a friend request is decoded with its flag', () => {
  const request = normalizeRequestEvent({ post_type: 'request', request_type: 'friend', flag: 'f1', user_id: 555, nickname: '小明', comment: '加个好友' });
  assert.deepEqual(request, { kind: 'friend', flag: 'f1', userId: 555, nickname: '小明', groupId: 0, comment: '加个好友' });
});

test('a group join request keeps the group id', () => {
  const request = normalizeRequestEvent({ post_type: 'request', request_type: 'group', sub_type: 'add', flag: 'g1', group_id: 999, user_id: 556, nickname: '小红' });
  assert.equal(request.kind, 'group-add');
  assert.equal(request.groupId, 999);
});

test('a group invitation may arrive as a request or a notice', () => {
  const asRequest = normalizeRequestEvent({ post_type: 'request', request_type: 'group', sub_type: 'invite', flag: 'g2', group_id: 998, user_id: 557 });
  const asNotice = normalizeRequestEvent({ post_type: 'notice', notice_type: 'group_invite', flag: 'g3', group_id: 997, user_id: 558 });
  assert.equal(asRequest.kind, 'group-invite');
  assert.equal(asNotice.kind, 'group-invite');
  assert.equal(asNotice.groupId, 997);
});

test('requests without a flag are ignored', () => {
  assert.equal(normalizeRequestEvent({ post_type: 'request', request_type: 'friend', user_id: 1 }), undefined);
  assert.equal(normalizeRequestEvent({ post_type: 'message', message_type: 'private' }), undefined);
});

test('the notification names the request and the reply format', () => {
  const text = describeRequest({ kind: 'group-add', userId: 556, nickname: '小红', groupId: 999, comment: '想进群' }, 3);
  assert.match(text, /入群申请 #3/);
  assert.match(text, /小红\(556\)/);
  assert.match(text, /群：999/);
  assert.match(text, /想进群/);
  assert.match(text, /\/同意 3/);
});

test('a group invitation card shows the group name and number', () => {
  const card = {
    app: 'com.tencent.structmsg',
    view: 'groupInvite',
    meta: { invite: { title: '邀请你加入群聊', desc: '电子竞技干饭群', group_name: '电子竞技干饭群', group_code: '123456789' } },
  };
  const text = describeCard({ type: 'json', data: { data: JSON.stringify(card) } });
  assert.match(text, /邀请你加入群聊/);
  assert.match(text, /电子竞技干饭群\(123456789\)/);
});

test('a video share card shows its title and link', () => {
  const card = { app: 'com.tencent.structmsg', desc: '哔哩哔哩', meta: { news: { title: '视频标题', desc: 'UP主：某人', jumpUrl: 'https://b23.tv/xxx', tag: '哔哩哔哩' } } };
  const text = describeCard({ type: 'json', data: { data: JSON.stringify(card) } });
  assert.match(text, /视频标题/);
  assert.match(text, /https:\/\/b23\.tv\/xxx/);
});
