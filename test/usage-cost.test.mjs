import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, sumCosts, cacheRate } from '../src/llm/cost.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openArchive } from '../src/archive/db.js';

test('cost uses each price bucket', () => {
  const estimate = estimateCost(
    { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000 },
    { input: 1, output: 2, cache: 0.1 },
  );
  assert.deepEqual(estimate, { input: 1_000_000, output: 500_000, cache: 2_000_000, cost: 2.2 });
});

test('missing prices leave the cost unknown instead of zero', () => {
  assert.equal(estimateCost({ inputTokens: 10, outputTokens: 5 }, { input: 0, output: 0, cache: 0 }).cost, null);
  assert.equal(estimateCost({ inputTokens: 10 }, {}).cost, null);
});

test('sumCosts reports null when any row lacks a price', () => {
  assert.equal(sumCosts([{ input: 1, output: 0, cache: 0, cost: 0.5 }, { input: 1, output: 0, cache: 0, cost: null }]).cost, null);
  assert.equal(sumCosts([{ input: 1, output: 0, cache: 0, cost: 0.5 }]).cost, 0.5);
});

test('cacheRate is the cached share of all input', () => {
  assert.equal(cacheRate({ input: 100, cache: 900 }), 0.9);
  assert.equal(cacheRate({ input: 0, cache: 0 }), 0);
});

test('the ledger stores tokens per turn and totals them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-usage-'));
  const archive = await openArchive(join(dir, 'a.db'));
  try {
    const now = Date.now();
    archive.insertTurn({ scene: 'dm:1', senderId: 1, tier: 'owner', startedAt: now - 1000, durationMs: 5, promptChars: 10, replyChars: 5, inputTokens: 1200, outputTokens: 300, cacheTokens: 800, ok: true });
    archive.insertTurn({ scene: 'group:2', senderId: 2, tier: 'member', startedAt: now, durationMs: 6, promptChars: 20, replyChars: 6, inputTokens: 400, outputTokens: 100, cacheTokens: 200, ok: true });
    const rows = archive.recentTurns(5);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].input_tokens, 400);
    assert.equal(rows[1].cache_tokens, 800);
    assert.deepEqual(archive.usageTotals(now - 10_000), { turns: 2, input: 1600, output: 400, cache: 1000 });
    assert.deepEqual(archive.usageTotals(now - 500), { turns: 1, input: 400, output: 100, cache: 200 });
  } finally {
    archive.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});
