import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHints } from '../src/context/hints.js';
import { TIER_TOOLS } from '../src/policy/restrictions.js';

test('a friend DM is not told about tools it cannot call', () => {
  const hints = buildHints({ tier: 'member', tools: TIER_TOOLS.member, lengthLimit: 300 });
  assert.doesNotMatch(hints, /group_digest/);
  assert.doesNotMatch(hints, /bilibili/);
  assert.doesNotMatch(hints, /subtitle/);
  // What it does have is still explained.
  assert.match(hints, /qq_send/);
  assert.match(hints, /回复长度/);
});

test('the owner gets every hint', () => {
  const hints = buildHints({ tier: 'owner', tools: '*', lengthLimit: 400 });
  for (const name of ['group_digest', 'bilibili', 'qq_send', 'subtitle']) {
    assert.match(hints, new RegExp(name), name);
  }
});

test('a group owner gets the digest hint but not the B站 one', () => {
  const hints = buildHints({ tier: 'owner-group', tools: TIER_TOOLS['owner-group'], lengthLimit: 300 });
  assert.match(hints, /group_digest/);
  assert.doesNotMatch(hints, /subtitle/);
});

test('the length rule uses the configured limit', () => {
  const short = buildHints({ tier: 'member', tools: TIER_TOOLS.member, lengthLimit: 120 });
  assert.match(short, /120/);
  assert.doesNotMatch(short, /300/);
});

test('a tier with no tools still gets the tool-free rules', () => {
  const hints = buildHints({ tier: 'member', tools: [], lengthLimit: 200 });
  assert.match(hints, /回复长度/);
  assert.doesNotMatch(hints, /qq_send/);
});
