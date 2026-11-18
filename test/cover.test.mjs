import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerQqCoverTool } from '../src/tools/cover.js';

/**
 * A fake `spawn` that prints the script's own JSON receipt and exits.
 *
 * @param {{ code?: number, lines?: string[] }} [options] Behaviour.
 * @returns {{ spawn: Function, calls: any[] }} Spawn stub and its calls.
 */
function fakeSpawn(options = {}) {
  const calls = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => {};
    calls.push({ command, args });
    const output = args[args.indexOf('--output') + 1];
    for (const line of options.lines ?? [`[cover] mixed -> ${output}`, JSON.stringify({ ok: true, output })]) {
      setTimeout(() => child.stdout.emit('data', `${line}\n`), 1);
    }
    setTimeout(() => child.emit('close', options.code ?? 0), 5);
    return child;
  };
  return { spawn, calls };
}

/**
 * Register the tool against a stub context and return the handler.
 *
 * @param {{ spawn: Function }} spinners Spawn stub.
 * @param {string} root Fake installation root.
 * @param {string} script Fake script path.
 * @returns {any} The tool definition.
 */
function toolWith(spinners, root, script) {
  let registered;
  const ctx = { tools: { register: definition => { registered = definition; return () => {}; } } };
  const bridge = {
    localVoice: {
      root: () => root,
      coverScript: () => script,
      config: () => ({ coverTimeoutMs: 60000 }),
    },
  };
  registerQqCoverTool(ctx, { bridge, spawnImpl: spinners.spawn, log: () => {} });
  return registered;
}

/**
 * Build a throwaway installation layout with a python and a script.
 *
 * @returns {{ root: string, script: string, song: string }} Paths.
 */
function layout() {
  const root = mkdtempSync(join(tmpdir(), 'cover-test-'));
  mkdirSync(join(root, 'envs', 'rvc', 'Scripts'), { recursive: true });
  writeFileSync(join(root, 'envs', 'rvc', 'Scripts', 'python.exe'), '');
  const script = join(root, 'feiyu_cover.py');
  writeFileSync(script, '');
  const song = join(root, 'song.wav');
  writeFileSync(song, 'RIFF');
  return { root, script, song };
}

test('qq_cover runs the shipped script against the RVC environment', async () => {
  const { root, script, song } = layout();
  const spinners = fakeSpawn();
  const tool = toolWith(spinners, root, script);
  const value = await tool.execute({ audio: song });

  assert.equal(spinners.calls.length, 1);
  const [call] = spinners.calls;
  assert.equal(call.command, join(root, 'envs', 'rvc', 'Scripts', 'python.exe'));
  assert.equal(call.args[0], '-B');
  assert.equal(call.args[1], script);
  assert.equal(call.args[call.args.indexOf('--input') + 1], song);
  assert.ok(call.args.includes('--mp3'));
  assert.equal(value.output.endsWith('.wav'), true);
  assert.match(value.report, /翻唱完成/);
});

test('qq_cover asks for vocals only when requested', async () => {
  const { root, script, song } = layout();
  const spinners = fakeSpawn();
  const tool = toolWith(spinners, root, script);
  await tool.execute({ audio: song, keepVocalsOnly: true });
  assert.ok(spinners.calls[0].args.includes('--vocals-only'));
});

test('qq_cover refuses a missing song', async () => {
  const { root, script } = layout();
  const tool = toolWith(fakeSpawn(), root, script);
  await assert.rejects(() => tool.execute({ audio: join(root, 'nope.wav') }), /找不到这个文件/);
});

test('qq_cover refuses when the installation is not configured', async () => {
  const { root, script, song } = layout();
  const tool = toolWith(fakeSpawn(), '', script);
  await assert.rejects(() => tool.execute({ audio: song }), /安装目录/);
  assert.equal(root.length > 0, true);
});

test('qq_cover reports the tail of a failed run', async () => {
  const { root, script, song } = layout();
  const spinners = fakeSpawn({ code: 1, lines: ['[cover] separating', 'CUDA out of memory'] });
  const tool = toolWith(spinners, root, script);
  await assert.rejects(() => tool.execute({ audio: song }), /翻唱失败（退出码 1）/);
});
