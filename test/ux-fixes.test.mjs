import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionMap } from '../src/bridge/sessions.js';
import { expandForward } from '../src/media/forward.js';
import { Approvals } from '../src/policy/approvals.js';

test('removing a binding without loading first never wipes the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-map-'));
  try {
    const file = join(dir, 'sessions.json');
    await writeFile(file, JSON.stringify({ 'dm:1': 's1', 'group:2': 's2' }), 'utf8');
    // A fresh process that mutates before any load must keep the other entries.
    const map = new SessionMap(file);
    await map.remove('sticker-describe');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved['dm:1'], 's1');
    assert.equal(saved['group:2'], 's2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a forward node keeps its own image even when it nests another forward', async () => {
  const payload = {
    messages: [{
      sender: { nickname: '甲' },
      message: [
        { type: 'image', data: { url: 'https://x/outer.png' } },
        { type: 'text', data: { text: '看这个' } },
        { type: 'forward', data: { id: 'inner-1' } },
      ],
    }],
  };
  const client = {
    call: async (action, params) => {
      if (action === 'get_forward_msg' && params.id === 'inner-1') {
        return { messages: [{ sender: { nickname: '乙' }, message: [{ type: 'text', data: { text: '内层' } }] }] };
      }
      return {};
    },
  };
  const result = await expandForward(client, payload, () => {});
  assert.deepEqual(result.images.map(image => image.data.url), ['https://x/outer.png']);
  assert.match(result.text, /内层/);
});

test('an image with only a file id is resolved through get_image', async () => {
  const payload = {
    messages: [{
      sender: { nickname: '甲' },
      message: [{ type: 'image', data: { file: 'abc.image' } }],
    }],
  };
  const calls = [];
  const client = {
    call: async (action, params) => {
      calls.push(action);
      if (action === 'get_image') return { url: 'https://x/resolved.png' };
      return {};
    },
  };
  const result = await expandForward(client, payload, () => {});
  assert.ok(calls.includes('get_image'));
  assert.deepEqual(result.images.map(image => image.data.url), ['https://x/resolved.png']);
});

test('/yes! grants the whole tool for the window', () => {
  const approvals = new Approvals();
  approvals.request('dm:1', 'pwsh', { command: 'git status' });
  const grant = approvals.grantTool('dm:1', 'pwsh');
  assert.equal(grant.tool, 'pwsh');
  assert.equal(approvals.allowed('dm:1', 'pwsh', { command: 'git status' }), true);
  assert.equal(approvals.allowed('dm:1', 'pwsh', { command: 'rm -rf /' }), true, 'the tool grant covers any arguments');
  assert.equal(approvals.allowed('dm:1', 'write', { path: 'a' }), false, 'other tools stay blocked');
  assert.equal(approvals.allowed('dm:1', 'pwsh', { command: 'x' }, Date.now() + 10 * 60_000), false, 'the window expires');
});

test('the approval preview shows the command, not a JSON blob', () => {
  const approvals = new Approvals();
  approvals.request('dm:1', 'pwsh', { command: 'Get-Process | Where-Object { $_.Name -eq "wegame" } | Select-Object Id' });
  const pending = approvals.pendingOf('dm:1');
  assert.match(pending.preview, /^Get-Process/);
  assert.ok(pending.preview.length <= 60);
});
