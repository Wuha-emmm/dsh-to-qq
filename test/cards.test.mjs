import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCard } from '../src/bridge/cards.js';
import { normalizeEvent } from '../src/bridge/events.js';

test('a news card keeps its headline instead of the category', () => {
  const card = {
    app: 'com.tencent.structmsg',
    desc: '新闻',
    view: 'news',
    meta: { news: { title: '三角洲行动新赛季上线', desc: '全新地图与武器平衡调整', jumpUrl: 'https://example.com/a', tag: '游戏' } },
  };
  const text = describeCard({ type: 'json', data: { data: JSON.stringify(card) } });
  assert.match(text, /三角洲行动新赛季上线/);
  assert.match(text, /全新地图与武器平衡调整/);
  assert.match(text, /https:\/\/example\.com\/a/);
  assert.equal(text.includes('· 新闻'), false, 'the category is not the headline');
});

test('a mini-app card exposes its title and body', () => {
  const card = { app: 'com.tencent.miniapp_01', meta: { detail_1: { title: '群签到', desc: '今日已签到 12 人', qqdocurl: 'https://qun.qq.com/x' } } };
  const text = describeCard({ type: 'json', data: { data: JSON.stringify(card) } });
  assert.match(text, /群签到/);
  assert.match(text, /今日已签到/);
  assert.equal(text.includes('com.tencent.miniapp_01'), false, 'app ids are not shown');
});

test('an xml card reads title, summary and source', () => {
  const xml = '<?xml version="1.0"?><msg serviceID="1"><item><title>分享一首歌</title><summary>周杰伦 - 晴天</summary><source>QQ音乐</source><url>https://y.qq.com/n/1</url></item></msg>';
  const text = describeCard({ type: 'xml', data: { data: xml } });
  assert.match(text, /分享一首歌/);
  assert.match(text, /周杰伦 - 晴天/);
  assert.match(text, /QQ音乐/);
});

test('an unreadable card yields no text so the placeholder stays', () => {
  assert.equal(describeCard({ type: 'json', data: { data: 'not json' } }), '');
  assert.equal(describeCard({ type: 'json', data: {} }), '');
  assert.equal(describeCard({ type: 'xml', data: { data: '<msg/>' } }), '');
});

test('flattening a message uses the card text', () => {
  const card = { app: 'com.tencent.structmsg', desc: '新闻', meta: { news: { title: '新赛季上线', desc: '武器调整' } } };
  const event = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: 10002,
    user_id: 10001,
    message_id: 9,
    time: 1700000000,
    sender: { user_id: 10001, nickname: '小明' },
    message: [{ type: 'json', data: { data: JSON.stringify(card) } }],
    raw_message: '[卡片]',
  };
  const message = normalizeEvent(event);
  assert.match(message.text, /新赛季上线/);
  assert.match(message.text, /武器调整/);
});

test('a card without readable fields keeps the bare placeholder', () => {
  const event = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: 10002,
    user_id: 10001,
    message_id: 10,
    time: 1700000001,
    sender: { user_id: 10001, nickname: '小明' },
    message: [{ type: 'json', data: { data: '{bad json' } }],
    raw_message: '[卡片]',
  };
  assert.equal(normalizeEvent(event).text, '[卡片]');
});
