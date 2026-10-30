import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeIncomingConfig } from '../src/config/merge.js';
import { defaults, mergeConfig } from '../src/config/defaults.js';

/** A configuration with a real stored token. */
const current = () => {
  const config = mergeConfig(defaults());
  config.connection.token = 'ws-secret';
  config.connection.httpToken = 'http-secret';
  return config;
};

test('a panel payload without tokens keeps the stored secrets', () => {
  const base = current();
  const payload = structuredClone(base);
  delete payload.connection.token;
  delete payload.connection.httpToken;

  const next = mergeIncomingConfig(base, payload);
  assert.equal(next.connection.token, 'ws-secret');
  assert.equal(next.connection.httpToken, 'http-secret');
});

test('a masked token does not overwrite the stored value', () => {
  const base = current();
  const next = mergeIncomingConfig(base, { connection: { token: '***', httpToken: '***' } });
  assert.equal(next.connection.token, 'ws-secret');
  assert.equal(next.connection.httpToken, 'http-secret');
});

test('an empty token does not clear the stored value', () => {
  const base = current();
  const next = mergeIncomingConfig(base, { connection: { token: '' } });
  assert.equal(next.connection.token, 'ws-secret');
});

test('a real token replaces the stored one', () => {
  const base = current();
  const next = mergeIncomingConfig(base, { connection: { token: 'new-secret' } });
  assert.equal(next.connection.token, 'new-secret');
  assert.equal(next.connection.httpToken, 'http-secret', 'the other field is untouched');
});

test('editing one section leaves the others alone', () => {
  const base = current();
  base.limits.replyDelayMs = 2000;
  base.access.admins = [{ qq: 10001, name: 'me', addedAt: 1 }];

  const next = mergeIncomingConfig(base, { limits: { replyDelayMs: 5000 } });
  assert.equal(next.limits.replyDelayMs, 5000);
  assert.equal(next.limits.jitterMs, base.limits.jitterMs, 'same section keeps its other fields');
  assert.deepEqual(next.access.admins, base.access.admins, 'other sections are untouched');
});

test('the read-only set fields never leak into storage', () => {
  const base = current();
  const next = mergeIncomingConfig(base, { connection: { tokenSet: true, httpTokenSet: true } });
  assert.equal('tokenSet' in next.connection, false);
  assert.equal('httpTokenSet' in next.connection, false);
});

test('garbage payloads are ignored', () => {
  const base = current();
  for (const garbage of [null, undefined, 'nope', 42, []]) {
    const next = mergeIncomingConfig(base, garbage);
    assert.equal(next.connection.token, 'ws-secret');
    assert.equal(next.limits.replyDelayMs, base.limits.replyDelayMs);
  }
});

