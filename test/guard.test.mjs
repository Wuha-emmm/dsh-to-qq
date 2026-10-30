import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelAccess } from '../src/web/guard.js';

test('loopback requests without an Origin are allowed', () => {
  assert.equal(panelAccess({ remoteAddress: '127.0.0.1' }).allowed, true);
  assert.equal(panelAccess({ remoteAddress: '::1' }).allowed, true);
  assert.equal(panelAccess({ remoteAddress: '::ffff:127.0.0.1' }).allowed, true);
});

test('non-loopback peers are rejected', () => {
  const verdict = panelAccess({ remoteAddress: '192.168.1.20' });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /non-loopback/);
  assert.equal(panelAccess({}).allowed, false);
});

test('same-origin browser requests are allowed', () => {
  const verdict = panelAccess({
    remoteAddress: '127.0.0.1',
    origin: 'http://127.0.0.1:53611',
    host: '127.0.0.1:53611',
  });
  assert.equal(verdict.allowed, true);
});

test('cross-origin browser requests are rejected', () => {
  const verdict = panelAccess({
    remoteAddress: '127.0.0.1',
    origin: 'https://evil.example',
    host: '127.0.0.1:53611',
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /cross-origin/);
});

test('a malformed Origin is rejected rather than trusted', () => {
  const verdict = panelAccess({ remoteAddress: '127.0.0.1', origin: 'null', host: '127.0.0.1:53611' });
  assert.equal(verdict.allowed, false);
});
