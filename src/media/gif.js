/**
 * Animated images: turn a few frames into one contact sheet.
 *
 * Providers usually see only the first frame of a GIF, which turns a reaction
 * image into something meaningless. A 3x3 sheet shows the motion cheaply.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Frames sampled from one animation. */
const FRAME_LIMIT = 9;

/** Script that composites the sheet. */
const SCRIPT = fileURLToPath(new URL('./gif-frames.ps1', import.meta.url));

/**
 * Whether these bytes are an animated GIF.
 *
 * @param {Uint8Array} bytes Image bytes.
 * @returns {boolean} True for `GIF8…` payloads.
 */
export function isGif(bytes) {
  return bytes.length > 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x38;
}

/**
 * Run the PowerShell compositor.
 *
 * @param {string} input Source image path.
 * @param {string} output Target PNG path.
 * @returns {Promise<string>} The script's stdout, e.g. `9/42`.
 */
function runScript(input, output) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      '-InPath', input,
      '-OutPath', output,
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`gif frames failed (${code}): ${stderr.slice(0, 200) || stdout.slice(0, 200)}`));
    });
  });
}

/**
 * Compose a contact sheet for an animated image.
 *
 * @param {Uint8Array} bytes Original bytes.
 * @param {(line: string) => void} [log] Diagnostic sink.
 * @returns {Promise<{ data: Uint8Array, frames: number, total: number } | undefined>} The sheet, or undefined when unavailable.
 */
export async function composeGifSheet(bytes, log = () => {}) {
  if (!isGif(bytes)) return undefined;
  const directory = await mkdtemp(join(tmpdir(), 'dsh-qq-gif-'));
  const input = join(directory, 'in.gif');
  const output = join(directory, 'sheet.png');
  try {
    await writeFile(input, bytes);
    const report = await runScript(input, output);
    const [framesText, totalText] = report.split('/');
    const frames = Number(framesText);
    const total = Number(totalText);
    if (!Number.isFinite(frames) || frames <= 0) return undefined;
    const sheet = new Uint8Array(await readFile(output));
    if (sheet.length === 0) return undefined;
    log(`gif sheet: ${frames}/${total} frames`);
    return { data: sheet, frames, total: Number.isFinite(total) ? total : frames };
  } catch (error) {
    log(`gif frames failed: ${error?.message ?? error}`);
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export { FRAME_LIMIT };
