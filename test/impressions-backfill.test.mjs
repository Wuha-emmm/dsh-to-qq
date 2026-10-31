import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfillImpressions } from '../src/bridge/impression-run.js';

const LONG = '这一句话有三十个字左右用来凑够素材门槛啊啊啊';

function makeBridge() {
  const senders = [111, 222, 333, 999];
  const bridge = {
    store: { get: () => ({ memory: { impressionsEnabled: true, impressionBudget: 600 }, connection: { botUin: 0 } }) },
    archive: {
      distinctSenders: () => senders,
      latestSenderMessages: sender => {
        if (sender === 111) return Array.from({ length: 6 }, (_, index) => ({ text: `${LONG}${index}`, time_unix: index + 1, scene: 'group:1' }));
        if (sender === 222) return [{ text: '太少了', time_unix: 1, scene: 'group:1' }];
        if (sender === 333) return Array.from({ length: 6 }, (_, index) => ({ text: `${LONG}旧${index}`, time_unix: index + 1, scene: 'group:1' }));
        return Array.from({ length: 6 }, (_, index) => ({ text: `${LONG}机器人${index}`, time_unix: index + 1, scene: 'group:1' }));
      },
    },
    memory: {
      get: sender => (sender === 333 ? { notes: [], impressionCursor: 1 } : { notes: [], impressionCursor: 0 }),
      setNotes: async () => {},
      setImpressionCursor: async () => {},
      impressionStats: () => ({}),
      impressionRuns: () => ({}),
    },
    driver: { ask: async () => ({ text: '' }) },
    summarize: async () => '- 说话直接\n- 喜欢技术话题',
    impressionStats: { backfillFilled: 0, scanned: 0, failed: 0, lastError: '', lastAt: 0, startedAt: 0, total: 0 },
    impressionBusy: false,
    selfId: 999,
    log: () => {},
    impressionRanAt: new Map(),
  };
  return bridge;
}

test('a manual backfill fills quiet members and reports why others were skipped', async () => {
  const bridge = makeBridge();
  const filled = await backfillImpressions(bridge, { relaxed: true });
  assert.equal(filled, 1, 'only the member above the relaxed gate is filled');
  assert.equal(bridge.impressionStats.scanned, 2, 'the bot itself is never scanned');
  assert.equal(bridge.impressionStats.skippedExisting, 1);
  assert.equal(bridge.impressionStats.skippedThin, 1);
  assert.equal(bridge.impressionStats.failed, 0);
});

test('an automatic backfill keeps the stricter threshold', async () => {
  const bridge = makeBridge();
  const filled = await backfillImpressions(bridge);
  assert.equal(filled, 0, '180 characters is below the automatic 300-character gate');
  assert.equal(bridge.impressionStats.skippedThin, 2);
});

test('the bot is skipped even when selfId is unknown', async () => {
  const bridge = makeBridge();
  bridge.selfId = 0;
  bridge.store = { get: () => ({ memory: { impressionsEnabled: true }, connection: { botUin: 999 } }) };
  await backfillImpressions(bridge, { relaxed: true });
  assert.equal(bridge.impressionStats.scanned, 2, '999 must not be scanned');
});
