import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openArchive, beijingTime } from '../src/archive/db.js';
import { summarizeDigest } from '../src/digest/daily.js';

/** Build one archive record. */
const record = (messageId, overrides = {}) => ({
  key: `10002:${messageId}`,
  selfId: 10002,
  kind: 'group',
  scene: 'group:20001',
  peerId: 20001,
  groupId: 20001,
  senderId: 10001,
  senderName: '小明',
  time: 1793374000 + messageId,
  text: `消息 ${messageId}`,
  messageId,
  ...overrides,
});

test('beijingTime formats as Asia/Shanghai wall clock', () => {
  // 2026-10-30T12:00:00Z is 20:00 in Beijing.
  assert.equal(beijingTime(Date.UTC(2026, 9, 30, 12, 0, 0) / 1000), '2026-10-30 20:00:00');
});

test('archive stores, dedupes, searches, and prunes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const archive = await openArchive(join(dir, 'archive.db'));
    assert.notEqual(archive, null);
    if (archive === null) return;

    assert.equal(archive.insert(record(1)), true);
    assert.equal(archive.insert(record(1)), false, 'same key must be ignored');
    archive.insert(record(2, { text: '讨论部署方案', senderId: 999, senderName: '路人' }));
    archive.insert(record(3, { scene: 'dm:10001', kind: 'dm', text: '私聊内容' }));

    assert.equal(archive.stats().messages, 3);

    assert.equal(archive.search({}).length, 3);
    assert.equal(archive.search({ keyword: '部署' }).length, 1);
    assert.equal(archive.search({ senderId: 999 }).length, 1);
    assert.equal(archive.search({ scene: 'dm:10001' }).length, 1);
    assert.equal(archive.search({ limit: 2 }).length, 2);

    // A future cutoff prunes everything; a generous one prunes nothing.
    assert.equal(archive.prune(1), 0);
    assert.equal(archive.prune(3650), 0);
    archive.insert(record(4, { time: Math.floor(Date.now() / 1000) - 86400 * 10 }));
    assert.equal(archive.prune(7), 1);

    archive.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('archive search returns newest first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const archive = await openArchive(join(dir, 'archive.db'));
    if (archive === null) return;
    archive.insert(record(10));
    archive.insert(record(11));
    archive.insert(record(12));
    const rows = archive.search({ limit: 3 });
    assert.equal(rows[0].msg_id, 12);
    assert.equal(rows.at(-1).msg_id, 10);
    archive.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('search returns time_unix and direction for the digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const archive = await openArchive(join(dir, 'archive.db'));
    if (archive === null) return;
    // 2026-10-30T12:00:00Z is 20:00 in Beijing.
    const time = Date.UTC(2026, 9, 30, 12, 0, 0) / 1000;
    archive.insert(record(20, { time, direction: 'in' }));
    const [row] = archive.search({ limit: 1 });
    assert.equal(row.time_unix, time, 'the digest buckets hours from time_unix');
    assert.equal(row.direction, 'in');

    const summary = summarizeDigest([row]);
    assert.equal(summary.peakHour, 20);
    assert.equal(summary.total, 1);

    archive.insert(record(21, { time, direction: 'out', senderName: 'DSH' }));
    const withOutbound = summarizeDigest(archive.search({ limit: 5 }));
    assert.equal(withOutbound.total, 1, 'outbound rows never count as a speaker');
    archive.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

