import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSendNotice, NOTICE_TTL_MS } from '../src/bridge/notice.js';

test('the same notice is not sent twice within the window', () => {
  const seen = new Map();
  const now = 1_000_000;
  assert.equal(shouldSendNotice(seen, 'dm:1', '已放行 pwsh 15 分钟', now), true);
  assert.equal(shouldSendNotice(seen, 'dm:1', '已放行 pwsh 15 分钟', now + 60_000), false);
  assert.equal(shouldSendNotice(seen, 'dm:1', '已放行 pwsh 15 分钟', now + NOTICE_TTL_MS + 1), true);
});

test('a different notice or a different scene always goes out', () => {
  const seen = new Map();
  const now = 2_000_000;
  assert.equal(shouldSendNotice(seen, 'dm:1', '已放行 pwsh 15 分钟', now), true);
  assert.equal(shouldSendNotice(seen, 'dm:1', '已放行 edit 15 分钟', now), true);
  assert.equal(shouldSendNotice(seen, 'dm:2', '已放行 pwsh 15 分钟', now), true);
});

test('an empty notice is dropped', () => {
  assert.equal(shouldSendNotice(new Map(), 'dm:1', '   '), false);
});
