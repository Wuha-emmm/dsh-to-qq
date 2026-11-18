import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';

import { LocalVoice } from '../src/speech/local.js';
import { TtsWarmVoice } from '../src/speech/tts-warm.js';
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
 * A stand-in for the resident TTS worker: answers `ready`, writes a wav for
 * every synth request, and records the protocol traffic.
 *
 * @param {{ audio?: string, fail?: boolean }} [options] Behaviour.
 * @returns {{ spawn: Function, spawns: any[], lines: any[] }} Spawn stub and its log.
 */
function fakeTtsWorker(options = {}) {
  const spawns = [];
  const lines = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.pid = 5150;
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = {
      write(text) {
        const message = JSON.parse(text);
        lines.push(message);
        if (message.op === 'synth') {
          if (options.fail === true) {
            setTimeout(() => child.stdout.emit('data', `${JSON.stringify({ op: 'synth', ok: false, error: 'CUDA out of memory' })}\n`), 1);
            return;
          }
          writeFileSync(message.output, Buffer.from(options.audio ?? 'RIFF-tts'));
          setTimeout(() => child.stdout.emit('data', `${JSON.stringify({ op: 'synth', ok: true, ms: 1790, seconds: 2.36, sample_rate: 24000, style: message.style ?? 'cute' })}\n`), 1);
          return;
        }
        if (message.op === 'ping') {
          setTimeout(() => child.stdout.emit('data', `${JSON.stringify({ op: 'ping', ok: true, rss_mb: 5200, gpu_mb: 3500 })}\n`), 1);
        }
      },
    };
    spawns.push({ command, args, child });
    setTimeout(() => {
      child.stdout.emit('data', `${JSON.stringify({ op: 'ready', ok: true, styles: ['cute', 'gentle'], style: 'cute', sample_rate: 24000, load_ms: 16000, prewarm_ms: 3600, device: 'cuda:0' })}\n`);
    }, 1);
    return child;
  };
  return { spawn, spawns, lines };
}

test('local TTS is on by default and derives the TTS paths from the root', () => {
  const { spawn } = fakeTtsWorker();
  const local = new LocalVoice({ store: storeWith({ enabled: true, root: 'E:\\feiyu' }), spawnImpl: spawn });
  assert.equal(local.ttsWarmEnabled(), true);
  assert.equal(local.ttsWarmVoice.pythonPath(), 'E:\\feiyu\\envs\\tts\\Scripts\\python.exe');
  assert.equal(local.ttsWarmVoice.modelPath(), 'E:\\feiyu\\models\\FeiyuVoice-CosyVoice3');
  assert.equal(local.ttsWarmVoice.profilePath(), 'E:\\feiyu\\server\\configs\\runtime.tts.cuda.local.json');
  assert.equal(local.ttsWarmVoice.serverPath(), 'E:\\feiyu\\server');
});

test('the resident TTS worker starts once and speaks without a second spawn', async () => {
  const { spawn, spawns, lines } = fakeTtsWorker();
  const voice = new TtsWarmVoice({ store: storeWith({ enabled: true, root: 'E:\\feiyu' }), spawnImpl: spawn });
  const first = await voice.synthesize('晚上好呀。');
  const second = await voice.synthesize('今天也辛苦了。', { style: 'gentle' });
  assert.equal(spawns.length, 1);
  assert.equal(first.bytes.toString(), 'RIFF-tts');
  assert.equal(first.sampleRate, 24000);
  assert.equal(first.ms, 1790);
  assert.equal(second.kind, 'tts');
  assert.equal(second.style, 'gentle');
  assert.equal(voice.isReady(), true);
  assert.equal(lines.filter(line => line.op === 'synth').length, 2);
  assert.equal(lines[1].text, '今天也辛苦了。');
  // The model directory is passed through so the worker never guesses.
  assert.ok(spawns[0].args.includes('E:\\feiyu\\models\\FeiyuVoice-CosyVoice3'));
  assert.ok(spawns[0].args.includes('E:\\feiyu\\server'));
});

test('a failed synthesis reports the engine error and keeps the worker alive', async () => {
  const { spawn } = fakeTtsWorker({ fail: true });
  const voice = new TtsWarmVoice({ store: storeWith({ enabled: true, root: 'E:\\feiyu' }), spawnImpl: spawn });
  await assert.rejects(() => voice.synthesize('你好'), /CUDA out of memory/);
  assert.equal(voice.isReady(), true);
  assert.match(voice.status().lastError, /CUDA out of memory/);
});

test('stopping the TTS worker kills the process so the VRAM comes back', async () => {
  const { spawn } = fakeTtsWorker();
  const killed = [];
  const voice = new TtsWarmVoice({
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
  assert.equal(process.platform === 'win32' ? killed.length : 1, 1);
  assert.equal(voice.status().running, false);
  assert.equal(voice.isReady(), false);
});

test('LocalVoice speaks through the resident TTS worker and never calls fetch', async () => {
  const { spawn } = fakeTtsWorker();
  const local = new LocalVoice({
    store: storeWith({ enabled: true, root: 'E:\\feiyu' }),
    spawnImpl: spawn,
    fetchImpl: async () => {
      throw new Error('the queue must not be touched in warm mode');
    },
  });
  const audio = await local.synthesize('晚上好', { style: 'cute' });
  assert.equal(audio.bytes.toString(), 'RIFF-tts');
  assert.equal(audio.kind, 'tts');
  const status = await local.status();
  assert.equal(status.mode, 'warm');
  assert.equal(status.tts, true);
  assert.equal(status.ttsWarm.gpuMb, 3500);
  assert.deepEqual(status.styles, ['cute', 'gentle']);
});

test('turning the local TTS switch off keeps RVC working but refuses TTS', async () => {
  const { spawn } = fakeTtsWorker();
  const local = new LocalVoice({
    store: storeWith({ enabled: true, root: 'E:\\feiyu', ttsWarm: false }),
    spawnImpl: spawn,
  });
  assert.equal(local.ttsWarmEnabled(), false);
  await assert.rejects(() => local.synthesize('你好'), /常驻模式只装了 RVC/);
});

test('a style switch is passed through to the worker rather than restarting it', async () => {
  const { spawn, spawns, lines } = fakeTtsWorker();
  const voice = new TtsWarmVoice({ store: storeWith({ enabled: true, root: 'E:\\feiyu' }), spawnImpl: spawn });
  await voice.synthesize('你好', { style: 'gentle' });
  await voice.synthesize('再见', { style: 'cute' });
  assert.equal(spawns.length, 1);
  assert.deepEqual(lines.map(line => line.style), ['gentle', 'cute']);
  assert.equal(existsSync(lines[0].output), false);
});
