import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, mergeConfig, normalize, RANGES } from '../src/config/defaults.js';

test('defaults expose every documented section', () => {
  const config = defaults();
  for (const section of ['connection', 'access', 'models', 'conversation', 'memory', 'limits', 'output', 'archive', 'safety', 'ui']) {
    assert.ok(config[section] && typeof config[section] === 'object', `missing section ${section}`);
  }
  assert.equal(config.conversation.groupHistory > 0, true);
  assert.equal(config.limits.replyDelayMs, 2000);
  assert.equal(config.limits.memberDaily, 100);
  assert.equal(config.archive.retentionDays, 30);
});

test('mergeConfig keeps unknown input out and fills gaps', () => {
  const config = mergeConfig({ limits: { memberDaily: 5 }, unknown: { a: 1 } });
  assert.equal(config.limits.memberDaily, 5);
  assert.equal(config.limits.groupDaily, 400);
  assert.equal(config.unknown, undefined);
  assert.equal(mergeConfig(null).limits.concurrency, 4);
  assert.equal(mergeConfig('nope').memory.summaryLimit, 1000);
});

test('normalize clamps numbers and sorts enums back to defaults', () => {
  const config = mergeConfig({
    limits: { concurrency: 99, replyDelayMs: -5 },
    output: { style: 'neon' },
    access: { groupMode: 'whatever' },
  });
  assert.equal(config.limits.concurrency, RANGES['limits.concurrency'][1]);
  assert.equal(config.limits.replyDelayMs, RANGES['limits.replyDelayMs'][0]);
  assert.equal(config.output.style, 'light');
  assert.equal(config.access.groupMode, 'whitelist');
});

test('admin entries are validated and coerced', () => {
  const config = mergeConfig({
    access: { admins: [{ qq: '10001', name: 'me', addedAt: 1 }, { qq: 'abc' }, null, 42] },
  });
  assert.deepEqual(config.access.admins, [{ qq: 10001, name: 'me', addedAt: 1 }]);
});

test('normalize repairs malformed connection and model fields', () => {
  const config = mergeConfig({
    connection: { httpUrl: 5, eventPath: null },
    models: { owner: 'deepseek', member: null },
  });
  assert.equal(config.connection.httpUrl, 'http://127.0.0.1:3000');
  assert.equal(config.connection.eventPath, '/');
  assert.deepEqual(config.models.owner, { provider: '', model: '', effort: '' });
  assert.deepEqual(config.models.member, { provider: '', model: '', effort: '' });
});

test('normalize leaves a valid config untouched', () => {
  const once = mergeConfig(defaults());
  const twice = normalize(structuredClone(once));
  assert.deepEqual(twice, once);
});

