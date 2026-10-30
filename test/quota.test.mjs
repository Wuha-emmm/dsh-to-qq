import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Quota, Semaphore, dayKey } from '../src/policy/quota.js';

const limits = { memberDaily: 2, groupDaily: 3, userPerMinute: 2 };
const dm = { senderId: 1001, scene: 'dm:1001' };
const group = { senderId: 1001, scene: 'group:20001' };

test('dayKey uses the Beijing calendar day', () => {
  // 2026-10-31T16:30Z is already 2026-11-01 in Beijing.
  assert.equal(dayKey(Date.UTC(2026, 9, 30, 15, 30)), '2026-10-30');
  assert.equal(dayKey(Date.UTC(2026, 9, 31, 16, 30)), '2026-11-01');
});

test('owners bypass quotas entirely', () => {
  const quota = new Quota();
  for (let index = 0; index < 10; index += 1) {
    assert.equal(quota.check(dm, limits, 'owner').allowed, true);
    quota.record(dm, 'owner');
  }
});

test('member daily quota stops the third message', () => {
  const quota = new Quota();
  const now = Date.now();
  assert.equal(quota.check(dm, limits, 'member', now).allowed, true);
  quota.record(dm, 'member', now);
  assert.equal(quota.check(dm, limits, 'member', now).allowed, true);
  quota.record(dm, 'member', now);
  const blocked = quota.check(dm, limits, 'member', now);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'member-daily');
});

test('per-minute rate limit is independent of the daily counter', () => {
  const quota = new Quota();
  const now = Date.now();
  const rateOnly = { memberDaily: 99, groupDaily: 99, userPerMinute: 2 };
  quota.record(dm, 'member', now);
  quota.record(dm, 'member', now);
  const blocked = quota.check(dm, rateOnly, 'member', now);
  assert.equal(blocked.reason, 'rate');
  // A minute later the window is clear again.
  assert.equal(quota.check(dm, rateOnly, 'member', now + 61_000).allowed, true);
});

test('group daily quota counts per scene', () => {
  const quota = new Quota();
  const now = Date.now();
  const loose = { memberDaily: 99, groupDaily: 1, userPerMinute: 99 };
  quota.record(group, 'member-group', now);
  const blocked = quota.check(group, loose, 'member-group', now);
  assert.equal(blocked.reason, 'group-daily');
  // A different group is unaffected.
  assert.equal(quota.check({ senderId: 1001, scene: 'group:1' }, loose, 'member-group', now).allowed, true);
});

test('counters reset on the next Beijing day', () => {
  const quota = new Quota();
  const now = Date.UTC(2026, 9, 30, 12, 0);
  quota.record(dm, 'member', now);
  quota.record(dm, 'member', now);
  assert.equal(quota.check(dm, limits, 'member', now).allowed, false);
  const tomorrow = now + 24 * 3600 * 1000;
  assert.equal(quota.check(dm, limits, 'member', tomorrow).allowed, true);
});

test('Semaphore honours its limit and hands slots on in order', async () => {
  const semaphore = new Semaphore(2);
  const first = await semaphore.acquire();
  const second = await semaphore.acquire();
  assert.equal(semaphore.active, 2);

  const waiting = semaphore.acquire();
  assert.equal(semaphore.pending, 1);

  first();
  const third = await waiting;
  assert.equal(semaphore.pending, 0);
  assert.equal(semaphore.active, 2);

  second();
  third();
  assert.equal(semaphore.active, 0);
});

test('Semaphore never exceeds its limit under load', async () => {
  const semaphore = new Semaphore(2);
  let concurrent = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    const release = await semaphore.acquire();
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise(resolve => setTimeout(resolve, 5));
    concurrent -= 1;
    release();
  }));
  assert.equal(peak, 2);
  assert.equal(semaphore.active, 0);
  assert.equal(semaphore.pending, 0);
});

