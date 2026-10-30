import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSegments, safeFileName, downloadBytes, fetchInboundFile } from '../src/media/inbound-file.js';

test('fileSegments keeps only file segments', () => {
  assert.equal(fileSegments([{ type: 'text' }, { type: 'file', data: {} }, { type: 'file' }]).length, 2);
  assert.deepEqual(fileSegments(undefined), []);
});

test('safeFileName strips paths and separators', () => {
  assert.equal(safeFileName('报告.pdf'), '报告.pdf');
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\tmp\\a.txt'), 'a.txt');
  assert.equal(safeFileName('a<b>c|d.txt'), 'a_b_c_d.txt');
  assert.equal(safeFileName(''), 'file.bin');
  assert.equal(safeFileName(undefined), 'file.bin');
});

test('downloadBytes decodes base64 payloads', async () => {
  const bytes = await downloadBytes(`base64://${Buffer.from('hello').toString('base64')}`);
  assert.equal(Buffer.from(bytes).toString(), 'hello');
});

test('fetchInboundFile writes the file and returns its path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-file-'));
  try {
    const path = await fetchInboundFile(undefined, {
      data: { name: 'x.txt', url: `base64://${Buffer.from('content').toString('base64')}` },
    }, dir);
    assert.ok(path !== undefined);
    assert.equal(await readFile(path, 'utf8'), 'content');
    const names = await readdir(dir);
    assert.equal(names.length, 1);
    assert.match(names[0], /x\.txt$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fetchInboundFile asks the transport when only an id is present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-file-'));
  const calls = [];
  const client = {
    call: async (action, params) => {
      calls.push([action, params]);
      return { data: { base64: Buffer.from('from-transport').toString('base64') } };
    },
  };
  try {
    const path = await fetchInboundFile(client, { data: { name: 'y.bin', file: 'fileid' } }, dir);
    assert.deepEqual(calls[0][0], 'get_file');
    assert.equal(await readFile(path, 'utf8'), 'from-transport');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fetchInboundFile returns undefined without a url or client', async () => {
  assert.equal(await fetchInboundFile(undefined, { data: {} }, tmpdir()), undefined);
  assert.equal(await fetchInboundFile(undefined, { data: { url: 'x' } }, ''), undefined);
});
