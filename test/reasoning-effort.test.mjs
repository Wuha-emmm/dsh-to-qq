import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshDriver, SessionMap } from '../src/bridge/sessions.js';

function fakeController(records) {
  return {
    create: async () => ({ sessionId: 'session-new' }),
    selectModel: async request => {
      records.push(request);
      if (request.reasoningEffort !== undefined) {
        throw new Error('unknown reasoning effort for deepseek-flash: high');
      }
      return {};
    },
    follow: () => { throw new Error('not used'); },
  };
}

test('the reasoning level is sent with the selection and dropped when rejected', async () => {
  const records = [];
  const map = new SessionMap('');
  // An empty file path would force a write; keep the map in memory for the test.
  map.load = async () => {};
  map.get = () => undefined;
  map.set = async () => {};
  const driver = new DshDriver({
    controller: fakeController(records),
    map,
    log: () => {},
    chooseModel: async () => ({ provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' }),
  });
  await driver.sessionFor('dm:1', '', 'owner');
  assert.equal(records.length, 2, 'the rejected attempt is retried without the level');
  assert.equal(records[0].reasoningEffort, 'high');
  assert.equal(records[1].reasoningEffort, undefined);
  assert.equal(records[1].provider, 'deepseek-account');
});

test('a route without a level selects the model once', async () => {
  const records = [];
  const map = new SessionMap('');
  map.load = async () => {};
  map.get = () => undefined;
  map.set = async () => {};
  const driver = new DshDriver({
    controller: fakeController(records),
    map,
    log: () => {},
    chooseModel: async () => ({ provider: 'deepseek-account', model: 'deepseek-flash', effort: '' }),
  });
  await driver.sessionFor('dm:1', '', 'owner');
  assert.equal(records.length, 1);
  assert.equal(records[0].reasoningEffort, undefined);
});
