/**
 * Long replies are delivered as a picture.
 *
 * Rendering goes through Windows GDI+ in a short-lived PowerShell process: no
 * npm dependency, correct CJK shaping and line breaking, and the three card
 * styles share one script.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The renderer shipped beside this module. */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'text-image.ps1');

/** How long a render may take before it is abandoned. */
const RENDER_TIMEOUT_MS = 20_000;

/**
 * Run the PowerShell renderer.
 *
 * @param {string[]} args Arguments passed to powershell.exe.
 * @returns {Promise<void>} Resolves when the process exits successfully.
 */
function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** @type {Buffer[]} */
    const errors = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('renderer timed out'));
    }, RENDER_TIMEOUT_MS);
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`renderer exited ${code}: ${Buffer.concat(errors).toString('utf8').slice(0, 200)}`));
    });
  });
}

/**
 * Render text to a PNG.
 *
 * @param {object} request Render request.
 * @param {string} request.text Body text.
 * @param {string} request.outPath Target PNG path.
 * @param {'light' | 'dark' | 'bubble'} [request.style] Card style.
 * @param {number} [request.width] Image width in pixels.
 * @param {number} [request.fontSize] Font size in pixels.
 * @returns {Promise<string>} The PNG path.
 */
export async function renderTextImage(request) {
  await mkdir(dirname(request.outPath), { recursive: true });
  const textPath = `${request.outPath}.txt`;
  await writeFile(textPath, request.text, 'utf8');
  try {
    await runPowerShell([
      SCRIPT,
      '-TextPath', textPath,
      '-OutPath', request.outPath,
      '-Width', String(Math.round(request.width ?? 1080)),
      '-FontSize', String(Math.round(request.fontSize ?? 22)),
      '-Style', request.style ?? 'light',
    ]);
  } finally {
    await unlink(textPath).catch(() => {});
  }
  return request.outPath;
}

/**
 * Render and read the image back as a OneBot `base64://` payload.
 *
 * @param {object} request Render request.
 * @returns {Promise<string>} `base64://...` ready for an image segment.
 */
export async function renderTextImageBase64(request) {
  const path = await renderTextImage(request);
  try {
    const bytes = await readFile(path);
    return `base64://${bytes.toString('base64')}`;
  } finally {
    await unlink(path).catch(() => {});
  }
}
