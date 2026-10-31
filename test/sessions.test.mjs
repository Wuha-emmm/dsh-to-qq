import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshDriver, SessionMap } from '../src/bridge/sessions.js';
import { GuestRegistry } from '../src/policy/restrictions.js';

/**
 * Minimal stand-in for `ctx.sessionController` that answers a prompt with one
 * canned turn, delivered through a follow stream.
 */
class FakeController {
  constructor(options = {}) {
    this.request = undefined;
    this.created = 0;
    this.cancelled = 0;
    this.delayMs = options.delayMs ?? 5;
    this.failPrompt = options.failPrompt ?? 0;
    this.queue = [];
    this.waiters = [];
    this.cursor = 100;
  }

  async create() {
    this.created += 1;
    return { sessionId: `s${this.created}` };
  }

  async prompt(request) {
    if (this.failPrompt > 0) {
      this.failPrompt -= 1;
      throw Object.assign(new Error('session/not-found'), { code: 'session/not-found' });
    }
    this.request = request;
    const seq = (this.cursor += 1);
    setTimeout(() => {
      this.push({ type: 'user/message', seq, data: { source: { rpcId: request.requestId } } });
      this.push({ type: 'turn/start', seq: seq - 1, data: { turn: 1, step: 0 } });
      this.push({
        type: 'assistant/message',
        seq: seq + 1,
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好，我是 DSH' }] } },
      });
      if (this.compaction === true) {
        this.push({ type: 'compaction/end', seq: seq + 1.5, data: { removed: 10 } });
      }
      this.push({ type: 'turn/end', seq: seq + 2, data: { turn: 1, reason: { kind: 'completed' } } });
    }, this.delayMs);
    return { accepted: true };
  }

  cancel() {
    this.cancelled += 1;
  }

  follow(_request, signal) {
    const self = this;
    return (async function* follow() {
      yield { type: 'snapshot', cursor: self.cursor - 10, records: [], hasMore: false, projections: {} };
      while (!signal?.aborted) {
        const event = await self.next(signal);
        if (event === undefined) return;
        yield { type: 'event', event };
      }
    })();
  }

  push(event) {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve(event);
    else this.queue.push(event);
  }

  next(signal) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const waiter = {
        resolve: event => {
          signal?.removeEventListener('abort', onAbort);
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          resolve(event);
        },
      };
      const onAbort = () => waiter.resolve(undefined);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }
}

test('SessionMap persists bindings and tolerates a missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const map = new SessionMap(join(dir, 'sessions.json'));
    await map.load();
    assert.equal(map.get('dm:1'), undefined);
    await map.set('dm:1', 'session-a');
    await map.set('group:2', 'session-b');

    const reloaded = new SessionMap(join(dir, 'sessions.json'));
    await reloaded.load();
    assert.equal(reloaded.get('dm:1'), 'session-a');
    assert.deepEqual(reloaded.all(), { 'dm:1': 'session-a', 'group:2': 'session-b' });

    await reloaded.remove('dm:1');
    assert.equal(reloaded.get('dm:1'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DshDriver creates one session per scene and reuses it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const controller = new FakeController();
    const driver = new DshDriver({ controller, map: new SessionMap(join(dir, 'sessions.json')) });

    const first = await driver.ask({ scene: 'dm:1', text: 'hi', timeoutMs: 5000 });
    assert.equal(first.text, '你好，我是 DSH');
    assert.equal(first.sessionId, 's1');
    assert.equal(controller.created, 1);
    assert.equal(controller.request.content[0].text, 'hi');

    const second = await driver.ask({ scene: 'dm:1', text: 'again', timeoutMs: 5000 });
    assert.equal(second.sessionId, 's1');
    assert.equal(controller.created, 1, 'same scene must reuse the session');

    const other = await driver.ask({ scene: 'dm:2', text: 'hi', timeoutMs: 5000 });
    assert.equal(other.sessionId, 's2');
    assert.equal(controller.created, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DshDriver times out and cancels the turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const controller = new FakeController({ delayMs: 5000 });
    const driver = new DshDriver({ controller, map: new SessionMap(join(dir, 'sessions.json')) });
    await assert.rejects(
      () => driver.ask({ scene: 'dm:1', text: 'slow', timeoutMs: 250 }),
      /timed out/,
    );
    assert.equal(controller.cancelled, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DshDriver rebinds once when the stored session vanished', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const map = new SessionMap(join(dir, 'sessions.json'));
    await map.set('dm:1', 'stale-session');

    const controller = new FakeController({ failPrompt: 1 });
    const driver = new DshDriver({ controller, map });
    const result = await driver.ask({ scene: 'dm:1', text: 'x', timeoutMs: 2000 });
    assert.equal(result.text, '你好，我是 DSH');
    assert.equal(controller.created, 1);
    assert.equal(map.get('dm:1'), 's1', 'the stale binding must be replaced');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('guest scenes pre-bind an id and record the tier even when the controller renames it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const controller = new FakeController();
    const guests = new GuestRegistry();
    const guestStore = new SessionMap(join(dir, 'guests.json'));
    const driver = new DshDriver({
      controller,
      map: new SessionMap(join(dir, 'sessions.json')),
      guests,
      guestStore,
    });

    const result = await driver.ask({ scene: 'group:20001', text: 'hi', timeoutMs: 3000, tier: 'member-group' });
    assert.equal(result.text, '你好，我是 DSH');
    // FakeController ignores the requested id; the driver must move the tier record.
    assert.equal(result.sessionId, 's1');
    assert.equal(guests.tierOf('s1'), 'member-group');
    assert.deepEqual(guestStore.all(), { s1: 'member-group' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a compaction during the turn is reported to the bridge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-sess-'));
  const map = new SessionMap(join(dir, 'sessions.json'));
  try {
    const controller = new FakeController();
    controller.compaction = true;
    const driver = new DshDriver({ controller, map, log: () => {} });
    const result = await driver.ask({ scene: 'dm:1', text: '你好', timeoutMs: 5000 });
    assert.equal(result.compacted, true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a plain turn is not reported as compacted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-sess-'));
  const map = new SessionMap(join(dir, 'sessions.json'));
  try {
    const controller = new FakeController();
    const driver = new DshDriver({ controller, map, log: () => {} });
    const result = await driver.ask({ scene: 'dm:1', text: '你好', timeoutMs: 5000 });
    assert.equal(result.compacted, false);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
