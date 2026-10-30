import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeImpressions, backfillImpressions } from '../src/bridge/impression-run.js';

const config = {
  memory: {
    impressionsEnabled: true,
    impressionEvery: 20,
    impressionMinChars: 100,
    impressionBudget: 600,
  },
};

/**
 * A bridge stand-in with just the fields the runner touches.
 *
 * @param {{ messages?: any[], prompts?: string[] }} [options] Fixtures.
 * @returns {any} Fake bridge.
 */
function fakeBridge(options = {}) {
  const rows = options.messages ?? [];
  const cards = new Map();
  const saved = [];
  const prompts = options.prompts ?? [];
  return {
    store: { get: () => config },
    driver: {},
    archive: {
      distinctSenders: () => [10001, 10002],
      senderMessages: () => rows,
      latestSenderMessages: () => rows,
    },
    memory: {
      get: qq => cards.get(String(qq)) ?? { notes: [], persona: null, impressionCursor: 0 },
      setNotes: async (qq, notes) => { cards.set(String(qq), { notes, persona: null, impressionCursor: 0 }); },
      setImpressionCursor: async (qq, at) => { const card = cards.get(String(qq)); if (card) card.impressionCursor = at; },
      saveImpressionStats: async stats => { saved.push(stats); },
    },
    summarize: async prompt => { prompts.push(prompt); return '- 在写桥接插件\n- 说话简短'; },
    impressionStats: { backfillFilled: 0, scanned: 0, failed: 0, lastError: '', lastAt: 0, startedAt: 0, total: 0 },
    impressionBusy: false,
    impressionRanAt: new Map(),
    logs: [],
    log(line) { this.logs.push(line); },
    get saved() { return saved; },
    get cards() { return cards; },
  };
}

const batch = Array.from({ length: 25 }, (_, index) => ({
  scene: 'group:1',
  text: '这是第' + index + '句足够长的发言内容',
  time_unix: 1000 + index,
}));

test('backfill writes notes and advances the cursor', async () => {
  const bridge = fakeBridge({ messages: batch });
  const filled = await backfillImpressions(bridge);
  assert.equal(filled, 2, 'both senders qualified');
  assert.equal(bridge.cards.get('10001').notes.length, 2);
  assert.equal(bridge.cards.get('10001').impressionCursor, 1024);
  assert.equal(bridge.impressionStats.backfillFilled, 2);
  assert.ok(bridge.saved.length > 0, 'stats were persisted');
});

test('backfill skips people who already have a cursor', async () => {
  const bridge = fakeBridge({ messages: batch });
  await backfillImpressions(bridge);
  const prompts = [];
  bridge.summarize = async prompt => { prompts.push(prompt); return '- x'; };
  const second = await backfillImpressions(bridge);
  assert.equal(second, 0);
  assert.equal(prompts.length, 0);
});

test('a second summarize run inside the cooldown does nothing', async () => {
  const bridge = fakeBridge({ messages: batch });
  await backfillImpressions(bridge);
  const firstCount = bridge.impressionStats.scanned;
  bridge.impressionStats.scanned = 0;
  await summarizeImpressions(bridge);
  assert.equal(bridge.impressionStats.scanned, 0, 'every sender is inside the 30 minute cooldown');
  assert.ok(firstCount > 0);
});

test('a failing summarizer is recorded, not thrown', async () => {
  const bridge = fakeBridge({ messages: batch });
  bridge.summarize = async () => { throw new Error('no route'); };
  const filled = await backfillImpressions(bridge);
  assert.equal(filled, 0);
  assert.equal(bridge.impressionStats.failed, 2);
  assert.match(bridge.impressionStats.lastError, /no route/);
});

test('the retry accepts bullets after a shapeless first answer', async () => {
  const bridge = fakeBridge({ messages: batch });
  let call = 0;
  bridge.summarize = async () => {
    call += 1;
    return call === 1 ? '他在写一个桥接插件' : '- 在写桥接插件';
  };
  const filled = await backfillImpressions(bridge);
  assert.ok(filled > 0);
  assert.equal(bridge.impressionStats.retried, 1);
});

test('a disabled config stops the run before touching the archive', async () => {
  const bridge = fakeBridge({ messages: batch });
  bridge.store = { get: () => ({ memory: { ...config.memory, impressionsEnabled: false } }) };
  assert.equal(await backfillImpressions(bridge), 0);
  assert.equal(await summarizeImpressions(bridge), 0);
});
