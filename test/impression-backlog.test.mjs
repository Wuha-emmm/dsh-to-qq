import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeImpressions } from '../src/bridge/impression-run.js';

/**
 * A fake bridge whose archive answers `senderMessages` the way the real one does:
 * rows strictly newer than the cursor, oldest first, limited.
 */
function makeBridge(messages) {
  const state = { cursor: 0, batches: [] };
  const bridge = {
    store: { get: () => ({ memory: { impressionsEnabled: true, impressionEvery: 20, impressionMinChars: 100, impressionBudget: 600 } }) },
    archive: {
      distinctSenders: () => [777],
      senderMessages: (_id, since, limit) => messages.filter(row => row.time_unix > since).slice(0, limit),
    },
    memory: {
      get: () => ({ notes: [], persona: null, impressionCursor: state.cursor, name: '' }),
      setNotes: async () => {},
      setImpressionCursor: async (_id, at) => { state.cursor = at; },
      saveImpressionStats: async () => {},
      saveImpressionRuns: async () => {},
      impressionStats: () => ({}),
      impressionRuns: () => ({}),
    },
    driver: { ask: async () => ({ text: '' }) },
    summarize: async prompt => {
      const lines = prompt.split('\n').filter(line => line.trim() !== '');
      state.batches.push(lines.filter(line => /^_text_/.test(line.replace(/^- .*?(?=_text_)/, ''))).length > 0 ? prompt : prompt);
      return '- 只写事实\n- 稳定偏好';
    },
    impressionStats: { backfillFilled: 0, scanned: 0, failed: 0, lastError: '', lastAt: 0, startedAt: 0, total: 0 },
    impressionBusy: false,
    selfId: 0,
    impressionRanAt: new Map(),
    log: () => {},
  };
  return { bridge, state };
}

const messages = Array.from({ length: 45 }, (_, index) => ({
  scene: 'group:1',
  sender_id: 777,
  sender_name: '甲',
  time_unix: 1000 + index,
  text: `_text_${index}_这条消息用来满足内容丰富度要求_${index}`,
  media_kind: null,
}));

test('consecutive impression runs walk the backlog without skipping', async () => {
  const { bridge, state } = makeBridge(messages);
  await summarizeImpressions(bridge);
  assert.equal(state.cursor, messages[19].time_unix, 'first run stops at the 20th message');

  // The per-sender cooldown would otherwise skip the second pass in the same run.
  bridge.impressionRanAt.delete(777);
  await summarizeImpressions(bridge);
  assert.equal(state.cursor, messages[39].time_unix, 'second run continues from there');

  // Only five messages remain, below the batch size: nothing is processed and
  // the cursor stays put, so they are picked up once more arrive.
  bridge.impressionRanAt.delete(777);
  await summarizeImpressions(bridge);
  assert.equal(state.cursor, messages[39].time_unix);
});
