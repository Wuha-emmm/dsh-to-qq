import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Approvals, DANGEROUS_TOOLS } from '../src/policy/approvals.js';

test('a grant only covers the tool that was requested', () => {
  const approvals = new Approvals();
  approvals.request('dm:1', 'pwsh');
  assert.equal(approvals.allowed('dm:1', 'pwsh'), false, 'nothing is allowed before /yes');
  assert.equal(approvals.grant('dm:1'), 'pwsh');
  assert.equal(approvals.allowed('dm:1', 'pwsh'), true);
  assert.equal(approvals.allowed('dm:1', 'write'), false, 'other tools stay blocked');
});

test('a grant expires after its ttl', () => {
  const approvals = new Approvals(1000);
  const now = Date.now();
  approvals.request('dm:1', 'write');
  approvals.grant('dm:1');
  assert.equal(approvals.allowed('dm:1', 'write', now), true);
  assert.equal(approvals.allowed('dm:1', 'write', now + 2000), false);
});

test('granting without a pending request reports nothing', () => {
  const approvals = new Approvals();
  assert.equal(approvals.grant('dm:404'), undefined);
});

test('scenes do not share grants', () => {
  const approvals = new Approvals();
  approvals.request('dm:1', 'pwsh');
  approvals.grant('dm:1');
  assert.equal(approvals.allowed('dm:2', 'pwsh'), false);
});

test('the dangerous set covers the write and execute tools', () => {
  for (const name of ['write', 'edit', 'pwsh', 'plugin_manager']) {
    assert.equal(DANGEROUS_TOOLS.has(name), true, name);
  }
  assert.equal(DANGEROUS_TOOLS.has('read'), false);
});
