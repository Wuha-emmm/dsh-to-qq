import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Approvals, DANGEROUS_TOOLS, callSignature, looksLikeApproval } from '../src/policy/approvals.js';

test('a grant only covers the exact call that was requested', () => {
  const approvals = new Approvals();
  approvals.request('dm:1', 'pwsh', { command: 'git status' });
  assert.equal(approvals.allowed('dm:1', 'pwsh', { command: 'git status' }), false, 'nothing is allowed before /yes');

  const granted = approvals.grant('dm:1');
  assert.equal(granted.tool, 'pwsh');
  assert.match(granted.preview, /git status/);

  assert.equal(approvals.allowed('dm:1', 'pwsh', { command: 'git status' }), true);
  assert.equal(approvals.allowed('dm:1', 'pwsh', { command: 'rm -rf /' }), false, 'another command stays blocked');
  assert.equal(approvals.allowed('dm:1', 'write', { command: 'git status' }), false, 'other tools stay blocked');
});

test('a grant expires after its ttl', () => {
  const approvals = new Approvals(1000);
  const now = Date.now();
  approvals.request('dm:1', 'write', { path: 'a.txt' });
  approvals.grant('dm:1');
  assert.equal(approvals.allowed('dm:1', 'write', { path: 'a.txt' }, now), true);
  assert.equal(approvals.allowed('dm:1', 'write', { path: 'a.txt' }, now + 2000), false);
});

test('a stale pending request cannot be approved later', () => {
  const approvals = new Approvals(60_000, 1000);
  approvals.request('dm:1', 'pwsh', { command: 'ls' });
  const later = Date.now() + 5000;
  assert.equal(approvals.grant('dm:1', later), undefined, 'pending expires');
  assert.equal(approvals.allowed('dm:1', 'pwsh', { command: 'ls' }, later), false);
});

test('granting without a pending request reports nothing', () => {
  const approvals = new Approvals();
  assert.equal(approvals.grant('dm:404'), undefined);
});

test('scenes do not share grants', () => {
  const approvals = new Approvals();
  approvals.request('dm:1', 'pwsh', { command: 'ls' });
  approvals.grant('dm:1');
  assert.equal(approvals.allowed('dm:2', 'pwsh', { command: 'ls' }), false);
});

test('the argument signature is stable across key order and string forms', () => {
  assert.equal(callSignature({ a: 1, b: 2 }), callSignature({ b: 2, a: 1 }));
  assert.equal(callSignature('{"a":1,"b":2}'), callSignature({ a: 1, b: 2 }));
  assert.notEqual(callSignature({ a: 1 }), callSignature({ a: 2 }));
  assert.equal(callSignature(''), '');
});

test('the dangerous set covers the write and execute tools', () => {
  for (const name of ['write', 'edit', 'pwsh', 'plugin_manager']) {
    assert.equal(DANGEROUS_TOOLS.has(name), true, name);
  }
  assert.equal(DANGEROUS_TOOLS.has('read'), false);
});

test('an approval word tolerates the typos people actually type', () => {
  for (const text of ['/yes', '/yes!', 'yes', 'Yes', '好', '确认', '同意', '/yse!', 'yse', 'ys', 'ye']) {
    assert.equal(looksLikeApproval(text), true, text);
  }
  for (const text of ['no', '/no', '不是', '不要', '取消', '']) {
    assert.equal(looksLikeApproval(text), false, text);
  }
});

test('全放行 covers every guarded tool for the window', () => {
  const approvals = new Approvals();
  approvals.request('dm:1', 'edit', { path: 'config.json' });
  const granted = approvals.grantTools('dm:1', ['pwsh', 'edit', 'write', 'plugin_manager']);
  assert.deepEqual(granted.tools, ['pwsh', 'edit', 'write', 'plugin_manager']);
  for (const tool of granted.tools) assert.equal(approvals.allowed('dm:1', tool, { x: 1 }), true, tool);
  assert.equal(approvals.allowed('dm:1', 'edit', {}, Date.now() + 6 * 60_000), false, 'expires');
});
