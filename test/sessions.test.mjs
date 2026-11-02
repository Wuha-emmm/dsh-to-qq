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
    /** Records the opening snapshot carries, for recovery tests. */
    this.snapshotRecords = options.snapshotRecords ?? [];
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
      yield { type: 'snapshot', cursor: self.cursor - 10, records: self.snapshotRecords, hasMore: false, projections: {} };
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

test('DshDriver rebinds once when the stored session vanished', async () => {  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
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

test('a host-injected turn is handed to the watcher, a QQ turn is not', async () => {
  const controller = new FakeController();
  const driver = new DshDriver({ controller, map: { get: () => undefined }, log: () => {} });
  /** @type {string[]} */
  const delivered = [];
  driver.watch('s1', text => { delivered.push(text); });
  await new Promise(resolve => setTimeout(resolve, 10));

  // A subagent report: injected turn, no qq- rpcId.
  const seq1 = (controller.cursor += 1);
  controller.push({ type: 'user/message', seq: seq1, data: { source: { rpcId: 'host-injected' } } });
  controller.push({
    type: 'assistant/message',
    seq: seq1 + 1,
    data: { message: { content: [{ type: 'text', text: '子智能体跑完了' }] } },
  });
  controller.push({ type: 'turn/end', seq: seq1 + 2, data: { reason: { kind: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(delivered, ['子智能体跑完了'], 'the injected turn must reach the chat');

  // A QQ turn: ask() already delivers it, so the watcher must stay quiet.
  const seq2 = (controller.cursor += 1);
  controller.push({ type: 'user/message', seq: seq2, data: { source: { rpcId: 'qq-abc' } } });
  controller.push({
    type: 'assistant/message',
    seq: seq2 + 1,
    data: { message: { content: [{ type: 'text', text: '正常回复' }] } },
  });
  controller.push({ type: 'turn/end', seq: seq2 + 2, data: { reason: { kind: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(delivered, ['子智能体跑完了'], 'a QQ turn must not be delivered twice');

  driver.unwatch('s1');
});

test('an injected message inside a QQ turn does not make it foreign', async () => {
  const controller = new FakeController();
  const driver = new DshDriver({ controller, map: { get: () => undefined }, log: () => {} });
  /** @type {string[]} */
  const delivered = [];
  driver.watch('s1', text => { delivered.push(text); });
  await new Promise(resolve => setTimeout(resolve, 10));

  const seq = (controller.cursor += 1);
  controller.push({ type: 'user/message', seq, data: { source: { rpcId: 'qq-live' } } });
  controller.push({ type: 'turn/start', seq: seq + 1, data: { turn: 15, step: 0 } });
  controller.push({
    type: 'assistant/message',
    seq: seq + 2,
    data: { message: { content: [{ type: 'reasoning', text: '想想怎么截屏' }] } },
  });
  // The Host splices these into the running turn; neither carries an rpcId.
  controller.push({
    type: 'user/message',
    seq: seq + 3,
    data: { content: [{ type: 'text', text: 'The approval policy changed to never.' }], source: { kind: 'user-approval' } },
  });
  controller.push({
    type: 'user/message',
    seq: seq + 4,
    data: { content: [{ type: 'text', text: 'Current runtime context.' }], source: { kind: 'runtime-context' } },
  });
  controller.push({
    type: 'assistant/message',
    seq: seq + 5,
    data: { message: { content: [{ type: 'text', text: '桌面已经截好发给你了' }] } },
  });
  controller.push({ type: 'turn/end', seq: seq + 6, data: { reason: { kind: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(delivered, [], 'the injection must not turn the owner into a foreign prompt');

  driver.unwatch('s1');
});

test('a turn opened by a bare background event still reaches the chat', async () => {
  const controller = new FakeController();
  const driver = new DshDriver({ controller, map: { get: () => undefined }, log: () => {} });
  /** @type {string[]} */
  const delivered = [];
  driver.watch('s1', text => { delivered.push(text); });
  await new Promise(resolve => setTimeout(resolve, 10));

  // A settled subagent wakes the session: turn/start then a prompt with no
  // rpcId at all. This is not ask()'s turn, so its answer belongs in the chat.
  const seq = (controller.cursor += 1);
  controller.push({ type: 'turn/start', seq, data: { turn: 27, step: 0 } });
  controller.push({
    type: 'user/message',
    seq: seq + 1,
    data: { content: [{ type: 'text', text: 'Background subagent 0db7 settled.' }], source: { kind: 'subagent-settled' } },
  });
  controller.push({
    type: 'assistant/message',
    seq: seq + 2,
    data: { message: { content: [{ type: 'text', text: '四格都领完了，就等你点头。' }] } },
  });
  controller.push({ type: 'turn/end', seq: seq + 3, data: { turn: 27, reason: { kind: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(delivered, ['四格都领完了，就等你点头。'], 'the background turn must not be swallowed');

  driver.unwatch('s1');
});

test('ask reports the request id once the Host owns the turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const controller = new FakeController();
    const driver = new DshDriver({ controller, map: new SessionMap(join(dir, 'sessions.json')) });
    const seen = [];
    await driver.ask({
      scene: 'dm:7',
      text: 'hi',
      timeoutMs: 2000,
      onPrompt: info => seen.push(info),
    });
    assert.equal(seen.length, 1, 'one accepted prompt means one ownership report');
    assert.match(seen[0].requestId, /^qq-/);
    assert.equal(seen[0].sessionId, 's1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recoverTurn reads a lost turn back by its request id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const controller = new FakeController();
    controller.snapshotRecords = [
      { event: { type: 'user/message', seq: 1, data: { source: { rpcId: 'qq-old' } } } },
      { event: { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '上一条' }] } } } },
      { event: { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } } },
      { event: { type: 'user/message', seq: 4, data: { source: { rpcId: 'qq-lost' } } } },
      { event: { type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: '老爹，我这不是一直没死嘛' }] } } } },
      { event: { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } } },
    ];
    const driver = new DshDriver({ controller, map: new SessionMap(join(dir, 'sessions.json')) });

    assert.deepEqual(await driver.recoverTurn('s1', 'qq-lost', 100), { text: '老爹，我这不是一直没死嘛' });
    assert.equal(await driver.recoverTurn('s1', 'qq-unknown', 50), null, 'another turn must not be replayed');

    // The window may stop mid-turn while the Host is still finishing it: the
    // closing events then arrive live, and the text is assembled from there.
    controller.snapshotRecords = controller.snapshotRecords.slice(3, 5);
    const pending = driver.recoverTurn('s1', 'qq-lost', 2000);
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.push({
      type: 'assistant/message',
      seq: 7,
      data: { message: { content: [{ type: 'text', text: '，没死透' }] } },
    });
    controller.push({ type: 'turn/end', seq: 8, data: { reason: { kind: 'completed' } } });
    assert.deepEqual(await pending, { text: '老爹，我这不是一直没死嘛，没死透' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
