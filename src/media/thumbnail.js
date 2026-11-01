/**
 * Shrinking sticker previews.
 *
 * QQ serves custom faces at full size (often ~3 MB), which is far too much to
 * keep for a 58 px thumbnail and too slow to download 160 times. The image is
 * downloaded once, shrunk with the same GDI+ the cards use, and only the small
 * PNG is kept.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../render/thumbnail.ps1', import.meta.url));

/** Square box the thumbnail is fitted into. */
const DEFAULT_SIZE = 160;

/**
 * Run the PowerShell shrinker.
 *
 * @param {string} input Source image path.
 * @param {string} output Target PNG path.
 * @param {number} size Longest edge in pixels.
 * @param {number} timeoutMs Hard limit.
 * @returns {Promise<void>} Resolves when the file is written.
 */
export async function runResize(input, output, size, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      '-Source', input,
      '-Target', output,
      '-Size', String(size),
    ], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`thumbnail timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`thumbnail exited ${code}: ${stderr.trim().slice(0, 160)}`));
    });
  });
}

/**
 * Turn downloaded bytes into a small PNG on disk.
 *
 * Falls back to writing the original bytes when PowerShell is unavailable, so a
 * preview always exists even if shrinking fails.
 *
 * @param {Uint8Array} bytes Downloaded image.
 * @param {string} target Absolute PNG path to write.
 * @param {{ size?: number, timeoutMs?: number, log?: (line: string) => void }} [options] Limits.
 * @returns {Promise<boolean>} True when the file was written.
 */
export async function saveThumbnail(bytes, target, options = {}) {
  if (bytes === undefined || bytes.length === 0) return false;
  const size = Math.max(48, Math.min(512, Number(options.size) || DEFAULT_SIZE));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const directory = await mkdtemp(join(tmpdir(), 'dsh-to-qq-sticker-'));
  const source = join(directory, 'source.img');
  try {
    await writeFile(source, bytes);
    await runResize(source, target, size, timeoutMs);
    return true;
  } catch (error) {
    options.log?.(`thumbnail failed, keeping the original: ${error?.message ?? error}`);
    try {
      await writeFile(target, bytes);
      return true;
    } catch (writeError) {
      options.log?.(`thumbnail fallback write failed: ${writeError?.message ?? writeError}`);
      return false;
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Read a saved thumbnail back, for callers that need the bytes.
 *
 * @param {string} path Absolute path.
 * @returns {Promise<Uint8Array | undefined>} Bytes, or undefined when missing.
 */
export async function readThumbnail(path) {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return undefined;
  }
}


