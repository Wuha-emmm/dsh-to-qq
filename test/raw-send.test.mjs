import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRawSend, rawSendRefusal } from '../src/policy/raw-send.js';
import { Bridge } from '../src/bridge/runtime.js';

test('a shell command that posts to OneBot is refused', () => {
  for (const command of [
    'Invoke-RestMethod http://127.0.0.1:3000/send_private_msg -Body $body',
    'curl -X POST http://127.0.0.1:3000/upload_private_file',
    'Invoke-RestMethod http://127.0.0.1:3000/send_group_msg',
    'Invoke-RestMethod http://127.0.0.1:3000/upload_group_file',
  ]) {
    assert.equal(isRawSend(command), true, command);
    assert.match(rawSendRefusal(command), /qq_send/);
  }
});

test('ordinary commands pass through', () => {
  for (const command of [
    'Get-Process wegame',
    'Invoke-RestMethod http://127.0.0.1:3000/get_status',
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{TAB}')",
  ]) {
    assert.equal(isRawSend(command), false, command);
    assert.equal(rawSendRefusal(command), undefined);
  }
});

test('a panel-started turn finds its QQ context through the binding map', () => {
  const bridge = new Bridge({
    store: { get: () => ({ connection: { botUin: 0 }, access: { admins: [{ qq: 1363309111 }] }, limits: {}, conversation: {}, memory: {}, stickers: {}, output: {} }) },
    log: () => {},
    stateDir: '',
  });
  bridge.map = { all: () => ({ 'dm:1363309111': 's1', 'group:999': 's2' }) };
  assert.deepEqual(bridge.sessionContext('s1'), { qq: 1363309111, scene: 'dm:1363309111', tier: 'owner' });
  assert.deepEqual(bridge.sessionContext('s2'), { qq: 999, scene: 'group:999', tier: 'member-group' });
  assert.equal(bridge.sessionContext('unknown'), undefined);
  // The recovery is cached, so the next call is a plain lookup.
  assert.equal(bridge.sessionContext('s1')?.scene, 'dm:1363309111');
});
