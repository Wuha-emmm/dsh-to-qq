import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshDriver, SessionMap } from '../src/bridge/sessions.js';

function memoryMap() {
  const map = new SessionMap('');
  map.load = async () => {};
  map.get = () => undefined;
  map.set = async () => {};
  return map;
}

test('sessionFor routes the member tier through the member route', async () => {
  const tiers = [];
  const selections = [];
  const driver = new DshDriver({
    controller: {
      create: async () => ({ sessionId: 'session-member' }),
      selectModel: async request => { selections.push(request); return {}; },
      follow: () => { throw new Error('not used'); },
    },
    map: memoryMap(),
    log: () => {},
    chooseModel: async tier => {
      tiers.push(tier);
      return { provider: 'deepseek-account', model: tier === 'owner' ? 'deepseek-v4-pro' : 'deepseek-flash', effort: tier === 'owner' ? 'high' : 'low' };
    },
  });
  await driver.sessionFor('group:20001', '', 'member');
  assert.deepEqual(tiers, ['member']);
  assert.equal(selections[0].model, 'deepseek-flash');
  assert.equal(selections[0].reasoningEffort, 'low');
});

test('a changed route is re-selected on a later ask', async () => {
  const selections = [];
  let current = { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'low' };
  const controller = {
    async create() { return { sessionId: 'session-x' }; },
    async selectModel(request) { selections.push(request); return {}; },
    async prompt() {
      return { accepted: true };
    },
    follow(_request, signal) {
      return (async function* () {
        yield { type: 'snapshot', cursor: 0, records: [], hasMore: false, projections: {} };
        yield { type: 'event', event: { type: 'user/message', seq: 1, data: { source: { rpcId: 'r1' } } } };
        yield { type: 'event', event: { type: 'turn/start', seq: 2, data: { turn: 1, step: 0 } } };
        yield { type: 'event', event: { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'ok' }] } } } };
        yield { type: 'event', event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } } };
      })();
    },
    cancel() {},
  };
  const map = memoryMap();
  const driver = new DshDriver({
    controller,
    map,
    log: () => {},
    chooseModel: async () => current,
  });
  // First ask pins the low route.
  await driver.ask({ scene: 'group:20001', text: 'hi', tier: 'member', timeoutMs: 5000, requestId: 'r1' });
  assert.equal(selections[0].reasoningEffort, 'low');

  // The settings change to high; the throttled reconcile picks it up.
  current = { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' };
  driver.routeChecks.set('member', 0);
  await driver.ask({ scene: 'group:20001', text: 'hi again', tier: 'member', timeoutMs: 5000, requestId: 'r1' });
  const last = selections.at(-1);
  assert.equal(last.reasoningEffort, 'high');
});
