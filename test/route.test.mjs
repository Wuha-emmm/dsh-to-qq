import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRoute } from '../src/llm/route.js';

const catalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash' },
  groups: [{ id: 'deepseek-account', models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }],
};

test('an unroutable catalog default falls back to a routable provider', () => {
  assert.deepEqual(pickRoute(catalog), { provider: 'deepseek-account', model: 'deepseek-flash' });
});

test('a configured route is used when the catalog knows it', () => {
  assert.deepEqual(
    pickRoute(catalog, { provider: 'deepseek-account', model: 'deepseek-v4-pro' }),
    { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
  );
});

test('an unknown configured model within a known provider falls back to its first model', () => {
  assert.deepEqual(
    pickRoute(catalog, { provider: 'deepseek-account', model: 'nope' }),
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  );
});

test('a configured route the catalog does not know is ignored', () => {
  assert.deepEqual(
    pickRoute(catalog, { provider: 'made-up', model: 'x' }),
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  );
});

test('the catalog default wins when it is routable', () => {
  const routableDefault = {
    default: { provider: 'deepseek-official', model: 'deepseek-flash' },
    groups: [
      { id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] },
      { id: 'deepseek-account', models: [{ id: 'deepseek-flash' }] },
    ],
  };
  assert.deepEqual(pickRoute(routableDefault), { provider: 'deepseek-official', model: 'deepseek-flash' });
});

test('an empty catalog yields an empty route instead of throwing', () => {
  assert.deepEqual(pickRoute(undefined), { provider: '', model: '' });
  assert.deepEqual(pickRoute({ groups: [] }), { provider: '', model: '' });
});

test('account providers are preferred over other fallbacks', () => {
  const mixed = {
    default: {},
    groups: [
      { id: 'local-llama', models: [{ id: 'llama' }] },
      { id: 'deepseek-account', models: [{ id: 'deepseek-flash' }] },
    ],
  };
  assert.deepEqual(pickRoute(mixed), { provider: 'deepseek-account', model: 'deepseek-flash' });
});
