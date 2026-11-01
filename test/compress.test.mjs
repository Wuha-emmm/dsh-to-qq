import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compressForUpload, compressPayload, shouldCompress, UPLOAD_THRESHOLD_BYTES, CARD_QUALITY } from '../src/media/compress.js';

/**
 * Draw a screenshot-like bitmap. The BMP encoder keeps it big, which is the point:
 * GDI+ sniffs the content, so the .png name does not matter here.
 *
 * @param {string} path Target file.
 * @returns {boolean} True when the fixture was written.
 */
function makeBigPicture(path) {
  const lines = [
    'Add-Type -AssemblyName System.Drawing',
    '$bmp = New-Object System.Drawing.Bitmap 2560, 1440',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.Clear([System.Drawing.Color]::FromArgb(30, 30, 40))',
    "$font = New-Object System.Drawing.Font 'Consolas', 18",
    'for ($i = 0; $i -lt 40; $i++) { $g.DrawString("row $i  166,510  29:56:53", $font, [System.Drawing.Brushes]::White, 20, (20 + $i * 32)) }',
    '$g.Dispose()',
    `$bmp.Save('${path.replace(/\\/g, '/')}', [System.Drawing.Imaging.ImageFormat]::Bmp)`,
    '$bmp.Dispose()',
  ];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lines.join('\n')], { windowsHide: true });
  return result.status === 0;
}

test('only big raster files are worth re-encoding', () => {
  assert.equal(shouldCompress({ size: UPLOAD_THRESHOLD_BYTES + 1, name: 'shot.png' }), true);
  assert.equal(shouldCompress({ size: UPLOAD_THRESHOLD_BYTES - 1, name: 'shot.png' }), false);
  assert.equal(shouldCompress({ size: 5_000_000, name: 'shot.jpg' }), false);
  assert.equal(shouldCompress({ size: 5_000_000, name: 'clip.gif' }), false);
  assert.equal(shouldCompress({ size: 5_000_000, name: 'doc.pdf' }), false);
});

test('a small file is returned unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-to-qq-compress-'));
  const path = join(directory, 'small.png');
  try {
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const info = await stat(path);
    const result = await compressForUpload(path, { size: info.size });
    assert.equal(result.converted, false);
    assert.equal(result.path, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a missing file falls back to the original', async () => {
  const result = await compressForUpload('E:/definitely/not/here.png', { size: 4_000_000 });
  assert.equal(result.converted, false);
});

test('a big screenshot becomes a smaller jpeg copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-to-qq-compress-'));
  const path = join(directory, 'big.png');
  try {
    if (!makeBigPicture(path)) return; // no GDI+ in this environment
    const info = await stat(path);
    assert.ok(info.size > UPLOAD_THRESHOLD_BYTES, `fixture should be big, got ${info.size}`);
    const result = await compressForUpload(path, { size: info.size });
    assert.equal(result.converted, true);
    assert.match(result.path, /\.jpg$/);
    assert.ok(result.bytes < info.size, 'jpeg copy should be smaller');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

test('a rendered card payload comes back as a smaller jpeg', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-to-qq-card-'));
  const path = join(directory, 'card.png');
  try {
    if (!makeBigPicture(path)) return;
    const png = await readFile(path);
    const jpeg = await compressPayload('base64://' + png.toString('base64'));
    assert.match(jpeg.slice(0, 40), /^base64:\/\//);
    const out = Buffer.from(jpeg.replace('base64://', ''), 'base64');
    assert.ok(out.length < png.length, 'jpeg should be smaller');
    assert.ok(out[0] === 0xff && out[1] === 0xd8, 'payload should be JPEG');
    assert.equal(CARD_QUALITY, 92);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, { timeout: 30_000 });

test('an empty payload is returned untouched', async () => {
  assert.equal(await compressPayload(''), '');
  assert.equal(await compressPayload('base64://'), 'base64://');
});
