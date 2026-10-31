import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDigest, formatDigest, startOfBeijingDay, dayRange } from '../src/digest/daily.js';

const at = (hourBj, minute = 0) => Date.UTC(2026, 9, 30, hourBj - 8, minute) / 1000;

test('startOfBeijingDay lands on 00:00 Asia/Shanghai', () => {
  const noon = Date.UTC(2026, 9, 30, 4, 0); // 12:00 Beijing
  const start = startOfBeijingDay(noon);
  assert.equal(new Date(start + 8 * 3600 * 1000).toISOString(), '2026-10-30T00:00:00.000Z');
});

test('summarizeDigest counts senders, hours, and media', () => {
  const rows = [
    { sender_id: 1, sender_name: '阿明', time_unix: at(9), media_kind: null },
    { sender_id: 1, sender_name: '阿明', time_unix: at(9, 30), media_kind: 'image' },
    { sender_id: 2, sender_name: '小红', time_unix: at(21), media_kind: null },
    { sender_id: 2, sender_name: '小红', time_unix: at(21, 10), media_kind: 'voice' },
    { sender_id: 2, sender_name: '小红', time_unix: at(21, 20), media_kind: null },
  ];
  const summary = summarizeDigest(rows);
  assert.equal(summary.total, 5);
  assert.equal(summary.senders, 2);
  assert.equal(summary.images, 1);
  assert.equal(summary.voices, 1);
  assert.equal(summary.peakHour, 21);
  assert.equal(summary.peakCount, 3);
  assert.deepEqual(summary.top[0], ['小红', 3]);
});

test('summarizeDigest falls back to the sender id when no name exists', () => {
  const summary = summarizeDigest([{ sender_id: 42, time_unix: at(10) }]);
  assert.deepEqual(summary.top[0], ['42', 1]);
});

test('the bot\'s own replies never count as a speaker', () => {
  const rows = [
    { sender_id: 1, sender_name: '阿明', time_unix: at(9), direction: 'in' },
    { sender_id: 0, sender_name: 'DSH', time_unix: at(9, 5), direction: 'out' },
    { sender_id: 2, sender_name: '小红', time_unix: at(9, 10), direction: 'in' },
  ];
  const summary = summarizeDigest(rows);
  assert.equal(summary.total, 2, 'the outbound row is filtered out');
  assert.equal(summary.senders, 2);
  assert.equal(summary.top.some(([name]) => name === 'DSH'), false);
});

test('the ranking caps at ten speakers', () => {
  const rows = Array.from({ length: 14 }, (_, index) => ({
    sender_id: index + 1,
    sender_name: `用户${index}`,
    time_unix: at(10 + (index % 5)),
    direction: 'in',
  }));
  assert.equal(summarizeDigest(rows).top.length, 10);
});

test('formatDigest reports an empty day', () => {
  const text = formatDigest(summarizeDigest([]), '群 123', '10-30');
  assert.match(text, /一条消息都没有/);
});

test('formatDigest lists the peak hour and the top talkers', () => {
  const rows = [
    { sender_id: 1, sender_name: '阿明', time_unix: at(20) },
    { sender_id: 1, sender_name: '阿明', time_unix: at(20, 5) },
    { sender_id: 2, sender_name: '小红', time_unix: at(9) },
  ];
  const text = formatDigest(summarizeDigest(rows), '群 123', '10-30');
  assert.match(text, /消息 3 条，2 个人发言/);
  assert.match(text, /20:00 前后（2 条）/);
  assert.match(text, /阿明 —— 2 条/);
});

test('a day window covers exactly one Beijing day', () => {
  const now = Date.UTC(2026, 10, 1, 4, 5); // 12:05 Beijing on 1 Nov
  const today = dayRange('today', now);
  const yesterday = dayRange('yesterday', now);
  assert.equal(today.key, '2026-11-01');
  assert.equal(yesterday.key, '2026-10-31');
  assert.equal(today.untilUnix - today.sinceUnix, 86_400);
  assert.equal(yesterday.untilUnix, today.sinceUnix);
  assert.equal(dayRange('2026-10-30', now).key, '2026-10-30');
  assert.equal(dayRange('昨天', now).key, '2026-10-31');
});

test('yesterday rows are excluded from today and counted in yesterday', () => {
  const now = Date.UTC(2026, 10, 1, 4, 5);
  const rows = [
    { sender_id: 1, sender_name: '甲', time_unix: dayRange('today', now).sinceUnix + 60, direction: 'in', text: '今晚说的' },
    { sender_id: 2, sender_name: '乙', time_unix: dayRange('yesterday', now).sinceUnix + 60, direction: 'in', text: '昨晚说的' },
  ];
  const pick = day => rows.filter(row => row.time_unix >= dayRange(day, now).sinceUnix && row.time_unix < dayRange(day, now).untilUnix);
  assert.equal(summarizeDigest(pick('today')).total, 1);
  assert.equal(summarizeDigest(pick('yesterday')).total, 1);
  assert.equal(summarizeDigest(pick('today')).top[0][0], '甲');
});

test('the day before yesterday and relative days resolve too', () => {
  const now = Date.UTC(2026, 10, 1, 4, 5);
  assert.equal(dayRange('前天', now).key, '2026-10-30');
  assert.equal(dayRange('前日', now).key, '2026-10-30');
  assert.equal(dayRange('daybefore', now).key, '2026-10-30');
  assert.equal(dayRange('3天前', now).key, '2026-10-29');
  assert.equal(dayRange('-3', now).key, '2026-10-29');
  assert.equal(dayRange('2026-10-20', now).key, '2026-10-20');
});
