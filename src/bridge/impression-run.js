/**
 * Impression runs, lifted out of the Bridge class.
 *
 * Two entry points share one pipeline: `backfill` reads each person's newest
 * messages once, `summarize` walks the per-person cursor and refreshes anyone
 * with enough new material. Both avoid writing while another run is in flight.
 */

import { enoughSignal, buildImpressionPrompt, parseImpressionBullets } from '../memory/impressions.js';
import { filterNotes } from '../memory/sensitive.js';

/** Minimum gap before the same person is summarized again. */
const PER_SENDER_COOLDOWN_MS = 30 * 60_000;

/**
 * Persist the run counters so a restart keeps the panel's history.
 *
 * @param {any} bridge The bridge instance.
 * @returns {void}
 */
function persistStats(bridge) {
  if (typeof bridge.memory?.saveImpressionStats !== 'function') return;
  void bridge.memory.saveImpressionStats({
    lastAt: bridge.impressionStats.lastAt,
    filled: bridge.impressionStats.backfillFilled,
    scanned: bridge.impressionStats.scanned,
    failed: bridge.impressionStats.failed,
    retried: bridge.impressionStats.retried ?? 0,
  }).catch(error => {
    bridge.log(`impression stats save failed: ${error?.message ?? error}`);
  });
  if (typeof bridge.memory.saveImpressionRuns === 'function') {
    void bridge.memory.saveImpressionRuns(bridge.impressionRanAt).catch(error => {
      bridge.log(`impression cooldown save failed: ${error?.message ?? error}`);
    });
  }
}

/**
 * Ask the summarizer for one card and store the result.
 *
 * @param {any} bridge The bridge instance.
 * @param {number} senderId QQ number.
 * @param {{ notes?: Array<{ text: string }>, name?: string }} card Current card.
 * @param {ReadonlyArray<any>} batch Messages in chronological order.
 * @param {any} config Live configuration.
 * @returns {Promise<boolean>} True when notes were written.
 */
async function writeImpressions(bridge, senderId, card, batch, config) {
  const prompt = buildImpressionPrompt({
    name: card.name !== undefined && card.name !== '' ? card.name : String(senderId),
    qq: senderId,
    previous: Array.isArray(card.notes) ? card.notes : [],
    batch: batch.map(row => ({
      scene: typeof row.scene === 'string' && row.scene.startsWith('group:') ? '群' : '私聊',
      text: String(row.text ?? '').slice(0, 200),
    })),
  });

  let reply = '';
  try {
    if (typeof bridge.summarize !== 'function') throw new Error('no summarizer is wired');
    reply = await bridge.summarize(prompt);
  } catch (error) {
    // Counted once per person by the caller, not once per attempt.
    bridge.impressionStats.lastError = String(error?.message ?? error).slice(0, 160);
    bridge.log(`impression summary failed for ${senderId}: ${error?.message ?? error}`);
    return false;
  }

  const parseOptions = { budgetChars: Number(config.memory.impressionBudget) || 600, maxNotes: 8 };
  let notes = parseImpressionBullets(reply, parseOptions);
  if (notes.length === 0) {
    // The model answered in the wrong shape: ask once more, explicitly.
    bridge.log(`impression summary had no bullets for ${senderId}; retrying`);
    bridge.impressionStats.retried = (bridge.impressionStats.retried ?? 0) + 1;
    try {
      const strict = await bridge.summarize(
        `${prompt}\n\n上一次的输出没有可用的条目。请只输出条目：每行一条，以「- 」开头，不要任何前言、标题或解释。`,
      );
      notes = parseImpressionBullets(strict, { ...parseOptions, allowBare: true });
    } catch (error) {
      bridge.log(`impression retry failed for ${senderId}: ${error?.message ?? error}`);
    }
  }
  if (notes.length === 0) {
    bridge.log(`impression summary produced no bullets for ${senderId}`);
    return false;
  }
  // The summarizer is a model: drop private and work-record lines before they
  // ever reach the card, not only when it is rendered.
  const safe = filterNotes(notes).notes;
  if (safe.length === 0) {
    bridge.log(`impression summary was entirely private for ${senderId}; nothing stored`);
    return false;
  }
  await bridge.memory.setNotes(senderId, safe);
  await bridge.memory.setImpressionCursor(senderId, Number(batch[batch.length - 1].time_unix) || 0);
  bridge.impressionRanAt.set(senderId, Date.now());
  return true;
}

/**
 * Refresh impressions for everyone with enough new messages.
 *
 * @param {any} bridge The bridge instance.
 * @returns {Promise<number>} How many cards were updated.
 */
export async function summarizeImpressions(bridge) {
  const config = bridge.store.get();
  if (config.memory.impressionsEnabled !== true) return 0;
  if (!bridge.driver || !bridge.memory || !bridge.archive) return 0;
  if (bridge.impressionBusy === true) return 0;
  bridge.impressionBusy = true;

  const every = Math.max(20, Number(config.memory.impressionEvery) || 100);
  bridge.impressionStats.startedAt = Date.now();
  bridge.impressionStats.scanned = 0;
  bridge.impressionStats.failed = 0;
  bridge.impressionStats.total = bridge.archive.distinctSenders().length;
  bridge.impressionStats.lastAt = Date.now();

  let updated = 0;
  try {
    for (const senderId of bridge.archive.distinctSenders()) {
      if (senderId === bridge.selfId) continue;
      // Busy groups would otherwise re-summarize the same person every run.
      if (Date.now() - (bridge.impressionRanAt.get(senderId) ?? 0) < PER_SENDER_COOLDOWN_MS) continue;
      bridge.impressionStats.scanned += 1;
      const card = bridge.memory.get(senderId);
      const cursor = Number(card.impressionCursor ?? 0);
      // Read the OLDEST batch after the cursor, so no message is ever skipped.
      // Reading `every * 4` and keeping the tail silently dropped the first
      // three batches and then advanced the cursor past them.
      const rows = bridge.archive.senderMessages(senderId, cursor, every);
      if (rows.length < every) continue;
      const batch = rows;
      if (enoughSignal(batch, config.memory.impressionMinChars) !== true) continue;
      const ok = await writeImpressions(bridge, senderId, card, batch, config);
      if (ok) updated += 1;
      else bridge.impressionStats.failed += 1;
    }
  } finally {
    bridge.impressionBusy = false;
  }
  persistStats(bridge);
  return updated;
}

/**
 * Build first impressions for people who have none yet, without speaking.
 *
 * @param {any} bridge The bridge instance.
 * @param {{ perSender?: number }} [options] How many messages to read per person.
 * @returns {Promise<number>} How many cards were filled in.
 */
export async function backfillImpressions(bridge, options = {}) {
  const config = bridge.store.get();
  if (config.memory.impressionsEnabled !== true) return 0;
  if (!bridge.archive || !bridge.driver || !bridge.memory) return 0;
  if (bridge.impressionBusy === true) return 0;
  bridge.impressionBusy = true;
  const perSender = Math.max(50, Math.min(500, Number(options.perSender) || 200));
  // A manual run is an explicit request, so it accepts quieter members; the
  // automatic pass keeps the stricter threshold.
  const minChars = options.relaxed === true ? 120 : 300;
  const minDistinct = options.relaxed === true ? 4 : 8;
  bridge.impressionStats.startedAt = Date.now();
  bridge.impressionStats.scanned = 0;
  bridge.impressionStats.failed = 0;
  bridge.impressionStats.backfillFilled = 0;
  bridge.impressionStats.skippedExisting = 0;
  bridge.impressionStats.skippedThin = 0;
  bridge.impressionStats.total = bridge.archive.distinctSenders().length;

  // The bot is not a person: skip its own number even before selfId is learned.
  const self = Number(bridge.selfId) || Number(config.connection?.botUin) || 0;
  let filled = 0;
  try {
    for (const senderId of bridge.archive.distinctSenders()) {
      if (self > 0 && senderId === self) continue;
      const card = bridge.memory.get(senderId);
      // Someone already processed keeps their cursor; never overwrite it.
      if (Number(card.impressionCursor ?? 0) > 0) {
        bridge.impressionStats.skippedExisting += 1;
        continue;
      }
      const batch = bridge.archive.latestSenderMessages(senderId, perSender);
      bridge.impressionStats.scanned += 1;
      if (enoughSignal(batch, minChars, minDistinct) !== true) {
        bridge.impressionStats.skippedThin += 1;
        continue;
      }
      const ok = await writeImpressions(bridge, senderId, card, batch, config);
      if (ok) filled += 1;
      else bridge.impressionStats.failed += 1;
    }
  } finally {
    bridge.impressionBusy = false;
  }
  bridge.impressionStats.backfillFilled = filled;
  bridge.impressionStats.lastAt = Date.now();
  persistStats(bridge);
  if (filled > 0) bridge.log(`impressions backfilled for ${filled} people`);
  return filled;
}
