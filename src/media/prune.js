/**
 * Media retention.
 *
 * `archive.prune` deletes database rows; the files they point at need the same
 * treatment or the media directory grows forever. This module owns that half.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Skip files that are younger than this regardless of settings. */
const MIN_AGE_MS = 60_000;

/**
 * Delete archived media older than a retention window.
 *
 * @param {string} directory Media directory; a missing directory is not an error.
 * @param {number} days Retention in days; `0` means keep everything.
 * @param {{ now?: number, log?: (line: string) => void }} [options] Clock and sink.
 * @returns {Promise<number>} How many files were removed.
 */
export async function pruneMedia(directory, days, options = {}) {
  if (typeof directory !== 'string' || directory === '') return 0;
  if (!Number.isFinite(days) || days <= 0) return 0;
  const now = options.now ?? Date.now();
  const cutoff = now - days * 24 * 3600 * 1000;
  let removed = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(directory, entry.name);
    try {
      const info = await stat(full);
      if (now - info.mtimeMs < MIN_AGE_MS) continue;
      if (info.mtimeMs >= cutoff) continue;
      await rm(full, { force: true });
      removed += 1;
    } catch (error) {
      options.log?.(`media prune skipped ${entry.name}: ${error?.message ?? error}`);
    }
  }
  return removed;
}
