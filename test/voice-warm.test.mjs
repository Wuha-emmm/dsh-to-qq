import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { LocalVoice } from '../src/speech/local.js';
import { WarmVoice } from '../src/speech/warm.js';
import { defaults } from '../src/config/defaults.js';

/**
 * A store stub shaped like the real ConfigStore.
 *
 * @param {object} local The `speech.local` section.
 * @returns {{ get: () => object }} A store.
 */
function storeWith(local) {
  const config = defaults();
  config.speech.local = { ...config.speech.local, ...local };
  return { get: () => config };
}

/**
 * A stand-in for the resident worker: answers `ready`, then writes a wav for
 * every convert request, and records what it was asked to do.
 *
 * @param {{ audio?: string, fail?: boolean, readyDelayMs?: number }} [options] Behaviour.
 * @returns {{ spawn: Function, spawns: any[], lines: any[] }} Spawn stub and its log.
 */
function fakeWorker(options = {}) {
  const spawns = [];
  const lines = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = {
      writes: [],
      write(text) {
        child.stdin.writes.push(text);
        const message = JSON.parse(text);
        lines.push(message);
        if (message.op === 'convert') {
          if (options.fail === true) {
            setTimeout(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, op: 'convert', ok: false, error: 'CUDA out of memory' })}\n`), 1);
            return;
          }
          // The real worker writes the output file; so does the fake.
          writeFileSync(message.output, Buffer.from(options.audio ?? 'RIFF-warm'));
          setTimeout(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, op: 'convert', ok: true, ms: 143, seconds: 2.34, sample_rate: 40000 })}\n`), 1);
          return;
        }
        if (message.op === 'ping') {
          setTimeout(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, op: 'ping', ok: true, rss_mb: 2100, gpu_mb: 900 })}\n`), 1);
        }
      },
    };
    spawns.push({ command, args, child });
    setTimeout(() => {
      child.stdout.emit('data', `${JSON.stringify({ op: 'ready', device: 'cuda:0', load_ms: 7000, prewarm_ms: 4600 })}\n`);
    }, options.readyDelayMs ?? 1);
    return child;
  };
  return { spawn, spawns, lines };
}

test('warm mode is on by default and only needs an installation root', () => {
  const { spawn } = fakeWorker();
  const local = new LocalVoice({ store: storeWith({ enabled: true, root: 'E:\\feiyu' }), spawnImpl: spawn });
  assert.equal(local.warmEnabled(), true);
  assert.equal(local.enabled(), true);
  assert.equal(local.warmVoice.pythonPath(), 'E:\\feiyu\\envs\\rvc\\Scripts\\python.exe');
  assert.equal(local.warmVoice.packagePath(), 'E:\\feiyu\\models\\FeiyuVoice-RVC');
});

test('warm off falls back to the queue path', () => {
  const local = new LocalVoice({ store: storeWith({ enabled: true, warm: false, root: 'E:\\feiyu' }) });
  assert.equal(local.warmEnabled(), false);
  assert.equal(local.enabled(), true);
});

test('the resident worker starts once, then converts without a second spawn', async () => {
  const { spawn, spawns, lines } = fakeWorker();
  const voice = new WarmVoice({ store: storeWith({ enabled: true, root: 'E:\\feiyu' }), spawnImpl: spawn });
  const first = await voice.convert(Buffer.from('source-wav'));
  const second = await voice.convert(Buffer.from('source-wav'));
  assert.equal(spawns.length, 1);
  assert.equal(first.bytes.toString(), 'RIFF-warm');
  assert.equal(first.sampleRate, 40000);
  assert.equal(second.kind, 'rvc');
  assert.equal(voice.isReady(), true);
  assert.equal(lines.filter(line => line.op === 'convert').length, 2);
  assert.equal(voice.status().mode, 'warm');
  // The input file is cleaned up after the job.
  const convert = lines.find(line => line.op === 'convert');
  assert.equal(existsSync(convert.input), false);
});

test('a failed conversion reports the engine error and keeps the worker alive', async () => {
  const { spawn } = fakeWorker({ fail: true });
  const voice = new WarmVoice({ store: storeWith({ enabled: true, root: 'E:\\feiyu' }), spawnImpl: spawn });
  await assert.rejects(() => voice.convert(Buffer.from('x')), /CUDA out of memory/);
  assert.equal(voice.isReady(), true);
  assert.match(voice.status().lastError, /CUDA out of memory/);
});

test('stopping kills the resident process so the VRAM comes back', async () => {
  const { spawn, spawns } = fakeWorker();
  const killed = [];
  const voice = new WarmVoice({
    store: storeWith({ enabled: true, root: 'E:\\feiyu' }),
    spawnImpl: spawn,
    killImpl: () => {
      killed.push('taskkill');
      const child = new EventEmitter();
      setTimeout(() => child.emit('exit', 0), 1);
      return child;
    },
  });
  await voice.ensure();
  const result = await voice.stop();
  assert.deepEqual(result, { stopped: true });
  assert.equal(spawns.length, 1);
  assert.equal(process.platform === 'win32' ? killed.length : 1, 1);
  assert.equal(voice.status().running, false);
  assert.equal(voice.isReady(), false);
});

test('the LocalVoice wrapper routes conversion to the warm worker and never calls fetch', async () => {
  const { spawn } = fakeWorker();
  const local = new LocalVoice({
    store: storeWith({ enabled: true, root: 'E:\\feiyu' }),
    spawnImpl: spawn,
    fetchImpl: async () => {
      throw new Error('the queue must not be touched in warm mode');
    },
  });
  const audio = await local.convert(Buffer.from('source-wav'));
  assert.equal(audio.bytes.toString(), 'RIFF-warm');
  assert.equal(audio.sampleRate, 40000);
  const status = await local.status();
  assert.equal(status.mode, 'warm');
  assert.equal(status.rvc, true);
  assert.equal(status.tts, false);
  assert.equal(status.warm.gpuMb, 900);
});

test('warm mode refuses TTS when the local TTS switch is off', async () => {
  const { spawn } = fakeWorker();
  const local = new LocalVoice({
    store: storeWith({ enabled: true, root: 'E:\\feiyu', ttsWarm: false }),
    spawnImpl: spawn,
  });
  await assert.rejects(() => local.synthesize('你好'), /常驻模式只装了 RVC/);
});
