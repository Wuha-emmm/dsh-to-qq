/**
 * Local Feiyu voice service: her own voice, on this machine.
 *
 * The service is a small FastAPI queue (`server/` in the release) that keeps no
 * models of its own: every job starts a short-lived engine process, so an idle
 * service holds no显存 and no CUDA context at all. That is why the switch here
 * is a real off switch — disabled means nothing is spawned, nothing is queued
 * and `qq_voice` falls back to the hosted DeepSeek voice.
 *
 * Everything below talks to the documented job API:
 *
 *   POST /v1/speech            { voice, text, style }  -> 202 + job
 *   POST /v1/assets            multipart wav           -> 201 + { id }
 *   POST /v1/voice-conversion  { voice, audio_id }     -> 202 + job
 *   GET  /v1/jobs/{id}                                 -> job row (+ audio_url)
 *   GET  /v1/jobs/{id}/audio                           -> audio/wav
 *
 * `/health` is unauthenticated, which is what makes the switch cheap to poll.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { WarmVoice } from './warm.js';
import { TtsWarmVoice } from './tts-warm.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:9880';
const HEALTH_TIMEOUT_MS = 2500;
const POLL_MILLIS = 400;

/**
 * Resolve after a delay.
 *
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>} Resolves later.
 */
function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Turn a Buffer into an ArrayBuffer `Blob` can carry.
 *
 * @param {Buffer} bytes Raw bytes.
 * @returns {ArrayBuffer} An independent copy.
 */
function arrayBufferOf(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * The local voice switch, the service process, and the job client.
 */
export class LocalVoice {
  /**
   * @param {object} options Wiring.
   * @param {import('../config/store.js').ConfigStore} options.store Live configuration.
   * @param {(line: string) => void} [options.log] Diagnostic sink.
   * @param {Record<string, string | undefined>} [options.env] Environment for the child.
   * @param {typeof fetch} [options.fetchImpl] Injectable fetch, for tests.
   */
  constructor(options) {
    this.store = options.store;
    /** Diagnostic sink; accepts a function or a logger object. */
    const sink = options.log;
    this.log =
      typeof sink === 'function'
        ? sink
        : typeof sink?.info === 'function'
          ? sink.info.bind(sink)
          : () => {};
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.child = undefined;
    /** @type {import('node:fs').WriteStream | undefined} Service output sink. */
    this.logStream = undefined;
    /** @type {Promise<void> | undefined} A start already in flight. */
    this.starting = undefined;
    this.key = '';
    this.idleTimer = undefined;
    this.lastJobAt = 0;
    /** The resident-engine path; the queue path is the fallback when it is off. */
    this.warmVoice = new WarmVoice({
      store: this.store,
      log: this.log,
      env: this.env,
      spawnImpl: options.spawnImpl,
      killImpl: options.killImpl,
    });
    /** The resident CosyVoice path: her own voice instead of the hosted one. */
    this.ttsWarmVoice = new TtsWarmVoice({
      store: this.store,
      log: this.log,
      env: this.env,
      spawnImpl: options.spawnImpl,
      killImpl: options.killImpl,
    });
    this.stats = { started: 0, stopped: 0, jobs: 0, failures: 0, lastError: '', lastMs: 0, lastKind: '' };
  }

  /**
   * The `speech.local` section, never `undefined`.
   *
   * @returns {Record<string, any>} Configuration.
   */
  config() {
    return this.store?.get?.()?.speech?.local ?? {};
  }

  /**
   * Whether the switch is on. Off means `qq_voice` never touches this module.
   *
   * @returns {boolean} True when enabled and pointed at an installation.
   */
  enabled() {
    const config = this.config();
    if (config.enabled !== true) return false;
    // Warm only needs the installation root; the queue needs its checkout too.
    if (this.warmEnabled()) return this.root() !== '';
    return this.serverRoot() !== '';
  }

  /**
   * The installation directory holding `server/`, `envs/` and `models/`.
   *
   * @returns {string} Absolute path, or `''` when unset.
   */
  root() {
    return String(this.config().root ?? '').trim();
  }

  /**
   * The service checkout: `<root>/server` unless overridden.
   *
   * @returns {string} Absolute path, or `''`.
   */
  serverRoot() {
    const explicit = String(this.config().serverRoot ?? '').trim();
    if (explicit !== '') return explicit;
    const root = this.root();
    return root === '' ? '' : join(root, 'server');
  }

  /**
   * The cover script that ships with the plugin.
   *
   * @returns {string} Absolute path to `python/feiyu_cover.py`.
   */
  coverScript() {
    return fileURLToPath(new URL('../../python/feiyu_cover.py', import.meta.url));
  }

  /**
   * Whether the resident worker should be used instead of the queue.
   *
   * Warm needs `enabled`, `warm`, and an installation root; the queue is what
   * remains when the worker is turned off (rare, but it also keeps TTS usable
   * once that engine is installed, since the worker only converts so far).
   *
   * @returns {boolean} True when converting through the resident process.
   */
  warmEnabled() {
    return this.warmVoice.enabled();
  }

  /**
   * Whether her own CosyVoice3 voice is available through the resident worker.
   *
   * @returns {boolean} True when warm mode is on and the TTS switch is on.
   */
  ttsWarmEnabled() {
    return this.warmEnabled() && this.ttsWarmVoice.enabled();
  }

  /**
   * The Windows Python that runs the queue (CPU only, no torch).
   *
   * @returns {string} Absolute path, or `''` when it cannot be derived.
   */
  pythonPath() {
    const explicit = String(this.config().pythonPath ?? '').trim();
    if (explicit !== '') return explicit;
    const root = this.root();
    return root === '' ? '' : join(root, 'envs', 'service', 'Scripts', 'python.exe');
  }

  /**
   * Where the service listens.
   *
   * @returns {string} A base URL without a trailing slash.
   */
  baseUrl() {
    const raw = String(this.config().baseUrl ?? '').trim() || DEFAULT_BASE_URL;
    return raw.replace(/\/+$/, '');
  }

  /**
   * Locate the API key: explicit configuration first, then the file the service
   * writes on first start (`<data_dir>/api_key.txt`).
   *
   * @returns {Promise<string>} The bearer token, or `''`.
   */
  async apiKey() {
    const explicit = String(this.config().apiKey ?? '').trim();
    if (explicit !== '') return explicit;
    if (this.key !== '') return this.key;
    const server = this.serverRoot();
    if (server === '') return '';
    const candidates = [
      join(server, '.runtime', 'voice-service', 'api_key.txt'),
      join(server, 'runtime', 'voice-service', 'api_key.txt'),
      join(tmpdir(), 'feiyu-voice-api-key.txt'),
    ];
    for (const path of candidates) {
      try {
        const value = (await readFile(path, 'utf8')).trim();
        if (value.length >= 16) {
          this.key = value;
          return value;
        }
      } catch {
        // Missing file just means the service has not started yet.
      }
    }
    return '';
  }

  /**
   * Ask `/health`, cheaply and without a key.
   *
   * @param {number} [timeoutMs] Request budget.
   * @returns {Promise<{ up: boolean, version?: string, error?: string }>} Liveness.
   */
  async health(timeoutMs = HEALTH_TIMEOUT_MS) {
    try {
      const response = await this.fetchImpl(`${this.baseUrl()}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { up: false, error: `HTTP ${response.status}` };
      const payload = await response.json().catch(() => ({}));
      return { up: payload?.status === 'ok', version: String(payload?.version ?? '') };
    } catch (error) {
      return { up: false, error: error?.message ?? 'unreachable' };
    }
  }

  /**
   * Authenticated JSON call.
   *
   * @param {string} method HTTP verb.
   * @param {string} path Path under the base URL.
   * @param {any} [body] JSON body.
   * @returns {Promise<any>} Parsed response.
   */
  async api(method, path, body) {
    const key = await this.apiKey();
    if (key === '') throw new Error('本地声音服务还没有 API key：先启动服务一次，或手动填 speech.local.apiKey');
    const response = await this.fetchImpl(`${this.baseUrl()}${path}`, {
      method,
      headers: body === undefined
        ? { Authorization: `Bearer ${key}` }
        : { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`本地声音服务 ${method} ${path} 失败 ${response.status}：${text.slice(0, 300)}`);
    return text.trim() === '' ? {} : JSON.parse(text);
  }

  /**
   * What the installation can actually do right now.
   *
   * @returns {Promise<{ tts: boolean, rvc: boolean, styles: string[], queue?: any }>} Capabilities.
   */
  async capabilities() {
    if (this.warmEnabled()) {
      await this.warmVoice.ensure();
      const tts = this.ttsWarmEnabled();
      return { tts, rvc: true, styles: tts ? ['cute', 'gentle'] : [], queue: undefined, warm: true };
    }
    const payload = await this.api('GET', '/v1/capabilities');
    const tts = (payload?.tts ?? []).find(entry => entry?.available);
    const rvc = (payload?.rvc ?? []).find(entry => entry?.available);
    return {
      tts: tts !== undefined,
      rvc: rvc !== undefined,
      styles: Array.isArray(tts?.styles) ? tts.styles : [],
      queue: payload?.queue,
    };
  }

  /**
   * Make sure the service answers, starting it when allowed.
   *
   * @returns {Promise<void>} Resolves once `/health` is up.
   */
  async ensure() {
    if (this.warmEnabled()) {
      await this.warmVoice.ensure();
      return;
    }
    const current = await this.health();
    if (current.up) return;
    const config = this.config();
    if (config.autoStart === false) {
      throw new Error('本地声音服务没在运行，而且自动启动是关的（speech.local.autoStart）。');
    }
    await this.start();
  }

  /**
   * Start the queue process and wait for its health endpoint.
   *
   * @returns {Promise<void>} Resolves when the service answers.
   */
  async start() {
    if (this.warmEnabled()) {
      await this.warmVoice.ensure();
      return;
    }
    if (this.starting !== undefined) return this.starting;
    this.starting = this.#startOnce().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /**
   * One start attempt; the double-start case is handled by `/health` + the
   * service's own `service.lock`.
   *
   * @returns {Promise<void>} Resolves when healthy.
   */
  async #startOnce() {
    const config = this.config();
    const server = this.serverRoot();
    const python = this.pythonPath();
    if (server === '' || python === '') {
      throw new Error('还没配置本地声音目录：在设置里填「本地声音安装目录」（例如 E:\\feiyu）。');
    }
    try {
      await access(python);
    } catch {
      throw new Error(`本地声音的 Python 不在这里：${python}。是不是还没装？`);
    }
    const port = Number(new URL(this.baseUrl()).port || 9880);
    const dataDir = join(server, '.runtime', 'voice-service');
    await mkdir(dataDir, { recursive: true });
    const args = ['-B', '-m', 'feiyu_voice_service', '--host', '127.0.0.1', '--port', String(port)];
    const configFile = join(server, 'configs', 'voice_service.json');
    if (await this.#exists(configFile)) args.push('--config', configFile);
    const env = { ...this.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
    const extra = String(config.pathPrefix ?? '').trim();
    if (extra !== '') env.PATH = `${extra};${env.Path ?? env.PATH ?? ''}`;
    this.log(`starting feiyu voice service: ${python} ${args.join(' ')}`);
    // The queue prints its startup banner and any traceback to the console; a
    // detached child has no console here, so keep both streams in a file the
    // error message can point at.
    const logPath = join(dataDir, 'service.log');
    const sink = createWriteStream(logPath, { flags: 'a' });
    const child = spawn(python, args, { cwd: server, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.pipe(sink, { end: false });
    child.stderr?.pipe(sink, { end: false });
    this.logStream = sink;
    child.once('error', error => this.log(`feiyu voice service failed to spawn: ${error.message}`));
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      sink.end();
      if (this.logStream === sink) this.logStream = undefined;
      this.log(`feiyu voice service exited code=${code} signal=${signal}`);
    });
    this.child = child;
    this.stats.started += 1;

    const deadline = Date.now() + Number(config.startTimeoutMs ?? 60_000);
    let lastError = '';
    while (Date.now() < deadline) {
      const probe = await this.health(1_500);
      if (probe.up) {
        this.log(`feiyu voice service ready (${probe.version ?? '?'})`);
        this.#keyCacheReset();
        return;
      }
      lastError = probe.error ?? '';
      await sleep(350);
    }
    this.log(`feiyu voice service did not become healthy: ${lastError}`);
    throw new Error(
      `本地声音服务起不来（等了 ${Math.round(Number(config.startTimeoutMs ?? 60_000) / 1000)} 秒，${lastError || '无响应'}）。`
      + ` 日志在 ${logPath}；也可以手动跑一次看输出：${python} ${args.join(' ')}`,
    );
  }

  /**
   * Stop the queue and everything it spawned.
   *
   * The service keeps engine work in short-lived child processes; killing the
   * tree is what guarantees the GPU is released instead of finishing a job.
   *
   * @returns {Promise<{ stopped: boolean }>} Whether a process was signalled.
   */
  async stop() {
    this.#clearIdle();
    const warm = await this.warmVoice.stop();
    const ttsWarm = await this.ttsWarmVoice.stop();
    const child = this.child;
    if (child === undefined || child.pid === undefined) {
      // Someone else (a manual start) may own the port; leave it alone.
      this.logStream?.end();
      this.logStream = undefined;
      return { stopped: warm.stopped || ttsWarm.stopped };
    }
    this.child = undefined;
    this.stats.stopped += 1;
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('exit', () => resolve(undefined));
        killer.once('error', () => resolve(undefined));
      });
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }
    this.logStream?.end();
    this.logStream = undefined;
    this.log('feiyu voice service stopped');
    return { stopped: true };
  }

  /**
   * A snapshot for the settings page and `qq_voice_service status`.
   *
   * @returns {Promise<object>} Status fields.
   */
  async status() {
    const config = this.config();
    if (this.warmEnabled()) {
      const warm = this.warmVoice.status();
      const ttsWarm = this.ttsWarmVoice.status();
      let usage;
      if (warm.ready) usage = await this.warmVoice.ping();
      let ttsUsage;
      if (ttsWarm.ready) ttsUsage = await this.ttsWarmVoice.ping();
      const ttsReady = ttsWarm.ready;
      return {
        enabled: this.enabled(),
        mode: 'warm',
        running: warm.running || ttsWarm.running,
        healthy: warm.ready || ttsReady,
        version: '',
        error: String(ttsWarm.lastError || warm.lastError || ''),
        tts: ttsReady,
        rvc: warm.ready,
        styles: ttsReady ? ttsWarm.styles : [],
        queue: undefined,
        idleStopMinutes: Number(config.idleStopMinutes ?? 0),
        lastMs: this.stats.lastMs,
        lastKind: this.stats.lastKind,
        lastError: ttsWarm.lastError || warm.lastError,
        jobs: warm.jobs + ttsWarm.jobs,
        failures: this.stats.failures,
        serverRoot: this.serverRoot(),
        baseUrl: this.baseUrl(),
        warm: {
          ready: warm.ready,
          pid: warm.pid,
          device: warm.device,
          loadMs: warm.loadMs,
          prewarmMs: warm.prewarmMs,
          rssMb: usage?.rssMb ?? 0,
          gpuMb: usage?.gpuMb ?? 0,
        },
        ttsWarm: {
          enabled: this.ttsWarmEnabled(),
          ready: ttsReady,
          pid: ttsWarm.pid,
          style: ttsWarm.style,
          styles: ttsWarm.styles,
          device: ttsWarm.device,
          loadMs: ttsWarm.loadMs,
          prewarmMs: ttsWarm.prewarmMs,
          rssMb: ttsUsage?.rssMb ?? 0,
          gpuMb: ttsUsage?.gpuMb ?? 0,
          lastMs: ttsWarm.lastMs,
          lastError: ttsWarm.lastError,
        },
      };
    }
    const probe = this.serverRoot() === '' ? { up: false, error: 'not configured' } : await this.health();
    let capabilities = { tts: false, rvc: false, styles: [], queue: undefined };
    if (probe.up) {
      try {
        capabilities = await this.capabilities();
      } catch (error) {
        capabilities = { tts: false, rvc: false, styles: [], queue: undefined, error: error?.message ?? '' };
      }
    }
    return {
      enabled: this.enabled(),
      mode: String(config.mode ?? 'auto'),
      running: probe.up === true && this.child !== undefined,
      healthy: probe.up === true,
      version: probe.version ?? '',
      error: probe.up === true ? '' : String(probe.error ?? ''),
      tts: capabilities.tts,
      rvc: capabilities.rvc,
      styles: capabilities.styles,
      queue: capabilities.queue,
      idleStopMinutes: Number(config.idleStopMinutes ?? 0),
      lastMs: this.stats.lastMs,
      lastKind: this.stats.lastKind,
      lastError: this.stats.lastError,
      jobs: this.stats.jobs,
      failures: this.stats.failures,
      serverRoot: this.serverRoot(),
      baseUrl: this.baseUrl(),
    };
  }

  /**
   * Speak one line with her own voice (CosyVoice3).
   *
   * @param {string} text What to say.
   * @param {{ style?: string, instruct?: string }} [options] Voice style (`cute` / `gentle`) and
   *   an optional CosyVoice3 instruction that carries the emotion.
   * @returns {Promise<{ bytes: Buffer, ms: number, sampleRate: number, kind: string, style: string }>} A WAV.
   */
  async synthesize(text, options = {}) {
    const config = this.config();
    const style = String(options.style ?? config.style ?? 'cute');
    const instruct = String(options.instruct ?? '');
    if (this.warmEnabled()) {
      if (!this.ttsWarmEnabled()) {
        throw new Error('常驻模式只装了 RVC 变声：把设置里的「本地 TTS」打开，或者把「常驻预热」关掉走服务');
      }
      const result = await this.ttsWarmVoice.synthesize(text, { style, instruct });
      this.stats.jobs += 1;
      this.stats.lastMs = result.ms;
      this.stats.lastKind = 'tts';
      this.#armIdle();
      return result;
    }
    await this.ensure();
    const capabilities = await this.capabilities();
    if (!capabilities.tts) throw new Error('这台机器上没装 TTS 引擎（只有 RVC）');
    const result = await this.#runJob(
      '/v1/speech',
      { voice: 'feiyu', text, style },
      String(config.jobTimeoutMs ?? 180_000),
    );
    this.stats.lastKind = 'tts';
    return { ...result, kind: 'tts', style };
  }

  /**
   * Move an existing recording to her timbre with RVC.
   *
   * @param {Buffer} wav A wav/flac source recording.
   * @param {{ name?: string }} [options] Upload name.
   * @returns {Promise<{ bytes: Buffer, ms: number, sampleRate: number, kind: string }>} A WAV.
   */
  async convert(wav, options = {}) {
    await this.ensure();
    if (this.warmEnabled()) {
      const result = await this.warmVoice.convert(wav, options);
      this.stats.jobs += 1;
      this.stats.lastMs = result.ms;
      this.stats.lastKind = 'rvc';
      return result;
    }
    const config = this.config();
    const key = await this.apiKey();
    const form = new FormData();
    form.append('file', new Blob([arrayBufferOf(wav)], { type: 'audio/wav' }), options.name ?? 'source.wav');
    const upload = await this.fetchImpl(`${this.baseUrl()}/v1/assets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const created = await upload.text();
    if (!upload.ok) throw new Error(`上传音频失败 ${upload.status}：${created.slice(0, 300)}`);
    const assetId = String(JSON.parse(created)?.id ?? '');
    if (assetId === '') throw new Error('上传音频失败：服务没有返回 id');
    const result = await this.#runJob(
      '/v1/voice-conversion',
      { voice: 'feiyu', audio_id: assetId },
      String(config.jobTimeoutMs ?? 180_000),
    );
    this.stats.lastKind = 'rvc';
    return { ...result, kind: 'rvc' };
  }

  /**
   * Submit, poll, download — the whole job protocol in one place.
   *
   * @param {string} path Submit path.
   * @param {any} body Request body.
   * @param {number} timeoutMs Polling budget.
   * @returns {Promise<{ bytes: Buffer, ms: number, sampleRate: number }>} The audio.
   */
  async #runJob(path, body, timeoutMs) {
    const started = Date.now();
    const job = await this.api('POST', path, body);
    const id = String(job?.id ?? '');
    if (id === '') throw new Error('本地声音服务没有返回 job id');
    const deadline = Date.now() + timeoutMs;
    let row = job;
    while (Date.now() < deadline) {
      if (row?.status === 'success') break;
      if (row?.status === 'failed' || row?.status === 'interrupted') {
        const detail = String(row?.error ?? row?.status);
        this.stats.failures += 1;
        this.stats.lastError = detail;
        throw new Error(`本地推理失败：${detail}`);
      }
      await sleep(POLL_MILLIS);
      row = await this.api('GET', `/v1/jobs/${id}`);
    }
    if (row?.status !== 'success') {
      this.stats.failures += 1;
      this.stats.lastError = 'timeout';
      throw new Error(`本地推理超时（${Math.round(timeoutMs / 1000)} 秒还没好）`);
    }
    const audio = await this.#download(`/v1/jobs/${id}/audio`);
    const ms = Date.now() - started;
    this.stats.jobs += 1;
    this.stats.lastMs = ms;
    this.lastJobAt = Date.now();
    this.#armIdle();
    const sampleRate = Number(row?.audio?.sample_rate ?? 24_000);
    this.log(`feiyu job ${path} done in ${ms}ms (${audio.length}B @ ${sampleRate}Hz)`);
    return { bytes: audio, ms, sampleRate };
  }

  /**
   * Download a job's audio with the bearer token.
   *
   * @param {string} path Audio path.
   * @returns {Promise<Buffer>} The bytes.
   */
  async #download(path) {
    const key = await this.apiKey();
    const response = await this.fetchImpl(`${this.baseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`下载语音失败 ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error('本地推理返回了空音频');
    return bytes;
  }

  /**
   * Stop the service after a quiet period, so an idle machine holds nothing.
   *
   * @returns {void}
   */
  #armIdle() {
    this.#clearIdle();
    const minutes = Number(this.config().idleStopMinutes ?? 0);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.stop().catch(error => this.log(`idle stop failed: ${error.message}`));
    }, minutes * 60_000);
    this.idleTimer.unref?.();
  }

  /**
   * Drop the idle timer.
   *
   * @returns {void}
   */
  #clearIdle() {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /**
   * Forget the cached key after a (re)start, so a fresh `api_key.txt` is read.
   *
   * @returns {void}
   */
  #keyCacheReset() {
    this.key = '';
  }

  /**
   * Whether a path exists.
   *
   * @param {string} path Absolute path.
   * @returns {Promise<boolean>} Existence.
   */
  async #exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stop everything this module owns; used when the config turns the switch off
   * and when the plugin unloads.
   *
   * @returns {Promise<void>} Resolves when stopped.
   */
  async dispose() {
    this.#clearIdle();
    await this.stop().catch(() => {});
  }
}
