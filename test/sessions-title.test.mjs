import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshDriver } from '../src/bridge/sessions.js';

test('rename forwards a trimmed title to the controller', async () => {
  const calls = [];
  const driver = new DshDriver({
    controller: { rename: async request => calls.push(request) },
    map: {},
    log: () => {},
  });
  await driver.rename('session-1', '【私】小明');
  assert.deepEqual(calls, [{ sessionId: 'session-1', title: '【私】小明' }]);
});

test('rename ignores empty titles and truncates long ones', async () => {
  const calls = [];
  const driver = new DshDriver({
    controller: { rename: async request => calls.push(request) },
    map: {},
    log: () => {},
  });
  await driver.rename('s', '   ');
  assert.equal(calls.length, 0);
  await driver.rename('s', 'x'.repeat(120));
  assert.equal(calls[0].title.length, 60);
});

