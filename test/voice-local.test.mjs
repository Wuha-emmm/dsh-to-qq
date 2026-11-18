import test from 'node:test';
import assert from 'node:assert/strict';

import { LocalVoice } from '../src/speech/local.js';
import { defaults, mergeConfig } from '../src/config/defaults.js';

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
 * A fetch stub that answers the documented endpoints in order.
 *
 * @param {object} options Wiring.
 * @param {boolean} [options.tts] Whether `/v1/capabilities` reports a TTS engine.
 * @param {'success' | 'failed'} [options.job] Terminal job status.
 * @returns {{ fetch: Function, calls: string[] }} The stub and its call log.
 */
function fakeService(options = {}) {
  const calls = [];
  let polls = 0;
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init.method ?? 'GET'} ${path}`);
    if (path === '/health') return new Response(JSON.stringify({ status: 'ok', version: '0.2.0' }), { status: 200 });
    if (path === '/v1/capabilities') {
      return new Response(JSON.stringify({
        tts: options.tts === false ? [] : [{ voice: 'feiyu', available: true, styles: ['cute', 'gentle'] }],
        rvc: [{ voice: 'feiyu', available: true }],
      }), { status: 200 });
    }
    if (path === '/v1/speech') return new Response(JSON.stringify({ id: 'a'.repeat(32), status: 'queued' }), { status: 202 });
    if (path.startsWith('/v1/jobs/') && path.endsWith('/audio')) {
      return new Response(Buffer.from('RIFF0000WAVE'), { status: 200, headers: { 'content-type': 'audio/wav' } });
    }
    if (path.startsWith('/v1/jobs/')) {
      polls += 1;
      const status = polls === 1 ? 'running' : (options.job ?? 'success');
      return new Response(JSON.stringify({ id: 'a'.repeat(32), status, audio: { sample_rate: 40000 } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetch, calls };
}

test('the switch is off until it is turned on and pointed somewhere', () => {
  const off = new LocalVoice({ store: storeWith({}) });
  assert.equal(off.enabled(), false);
  const on = new LocalVoice({ store: storeWith({ enabled: true, root: 'E:\\feiyu' }) });
  assert.equal(on.enabled(), true);
  assert.equal(on.serverRoot(), 'E:\\feiyu\\server');
  assert.equal(on.pythonPath(), 'E:\\feiyu\\envs\\service\\Scripts\\python.exe');
});

test('synthesize follows submit -> poll -> download', async () => {
  const { fetch, calls } = fakeService();
  const local = new LocalVoice({ store: storeWith({ enabled: true, warm: false, root: 'E:\\feiyu', apiKey: 'k'.repeat(32) }), fetchImpl: fetch });
  const audio = await local.synthesize('你好', { style: 'gentle' });
  assert.equal(audio.kind, 'tts');
  assert.equal(audio.style, 'gentle');
  assert.equal(audio.bytes.toString(), 'RIFF0000WAVE');
  assert.deepEqual(calls, [
    'GET /health',
    'GET /v1/capabilities',
    'POST /v1/speech',
    'GET /v1/jobs/' + 'a'.repeat(32),
    'GET /v1/jobs/' + 'a'.repeat(32),
    'GET /v1/jobs/' + 'a'.repeat(32) + '/audio',
  ]);
});

test('a failed job throws with the service error instead of hanging', async () => {
  const local = new LocalVoice({
    store: storeWith({ enabled: true, warm: false, root: 'E:\\feiyu', apiKey: 'k'.repeat(32) }),
    fetchImpl: fakeService({ tts: false, job: 'failed' }).fetch,
  });
  await assert.rejects(() => local.synthesize('你好'), /没装 TTS|本地推理失败/);
});

test('synthesize refuses when only the converter is installed', async () => {
  const local = new LocalVoice({
    store: storeWith({ enabled: true, warm: false, root: 'E:\\feiyu', apiKey: 'k'.repeat(32) }),
    fetchImpl: fakeService({ tts: false }).fetch,
  });
  await assert.rejects(() => local.synthesize('你好'), /没装 TTS 引擎/);
});

test('a hand-edited local section is rebuilt from the defaults', () => {
  const config = mergeConfig({
    speech: {
      local: {
        enabled: 'yes',
        style: 'opera',
        idleStopMinutes: 99999,
        jobTimeoutMs: 5,
        startTimeoutMs: 'soon',
        root: 'E:\\feiyu',
      },
    },
  });
  assert.equal(config.speech.local.enabled, false);
  assert.equal(config.speech.local.style, 'cute');
  assert.equal(config.speech.local.idleStopMinutes, 1440);
  assert.equal(config.speech.local.jobTimeoutMs, 60_000);
  assert.equal(config.speech.local.startTimeoutMs, 60_000);
  assert.equal(config.speech.local.root, 'E:\\feiyu');
  // Keys the stored object never mentioned still exist.
  assert.equal(config.speech.local.autoStart, true);
  assert.equal(config.speech.local.warm, true);
  assert.equal(config.speech.local.baseUrl, 'http://127.0.0.1:9880');
});

test('a config that only sets the switch keeps every other local default', () => {
  const config = mergeConfig({ speech: { local: { enabled: true } } });
  assert.equal(config.speech.local.enabled, true);
  assert.equal(config.speech.local.style, 'cute');
  assert.equal(config.speech.local.idleStopMinutes, 15);
  assert.equal(config.speech.local.pathPrefix, '');
});

