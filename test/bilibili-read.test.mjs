import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHints } from '../src/context/hints.js';
import { TIER_TOOLS } from '../src/policy/restrictions.js';

test('a friend DM can read subtitles and is told so', () => {
  const hints = buildHints({ tier: 'member', tools: TIER_TOOLS.member, lengthLimit: 300 });
  assert.match(hints, /bilibili_read/);
  assert.match(hints, /subtitle/);
  // Writing is still not advertised.
  assert.doesNotMatch(hints, /group_digest/);
});

test('a group member can read subtitles too', () => {
  const hints = buildHints({ tier: 'member-group', tools: TIER_TOOLS['member-group'], lengthLimit: 300 });
  assert.match(hints, /bilibili_read/);
  assert.match(hints, /group_digest/);
});

test('the read tool is open to every non-owner tier while the write tool is not', () => {
  for (const tier of ['owner-group', 'member', 'member-group']) {
    assert.ok(TIER_TOOLS[tier].includes('bilibili_read'), tier);
    assert.equal(TIER_TOOLS[tier].includes('bilibili'), false, tier);
  }
});
