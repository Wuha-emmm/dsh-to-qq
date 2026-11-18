/**
 * Resident CosyVoice3 ("FeiyuVoice") worker: load the 0.5B model once, then
 * speak a sentence in about 0.6-1x real time.
 *
 * The release service spawns one engine process per job, so every sentence
 * pays the full model load (16 s here). This module keeps one process alive
 * and proxies text through a newline-delimited JSON protocol, which is what
 * the "本地 TTS" switch in the settings page turns off again (killing it is
 * what releases the ~3.5 GB of VRAM).
 *
 * The worker is `python/feiyu_tts_server.py`, shipped inside this bundle.
 */

import { spawn as spawnChild } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const READY_TIMEOUT_MS = 240_000;
const REQUEST_TIMEOUT_MS = 300_000;

/**
 * The resident TTS process and its protocol.
 */
export class TtsWarmVoice {
  /**
   * @param {object} options Wiring.
   * @param {import('../config/store.js').ConfigStore} options.store Live configuration.
   * @param {((line: string) => void) | { info?: (line: string) => void }} [options.log] Diagnostic sink.
   * @param {Record<string, string | undefined>} [options.env] Environment for the child.
   * @param {typeof spawnChild} [options.spawnImpl] Injectable spawn, for tests.
   * @param {typeof spawnChild} [options.killImpl] Injectable taskkill runner, for tests.
   */
  constructor(options) {
    this.store = options.store;
    const sink = options.log;
    this.log =
      typeof sink === 'function'
        ? sink
        : typeof sink?.info === 'function'
          ? sink.info.bind(sink)
          : () => {};
    this.env = options.env ?? process.env;
    this.spawnImpl = options.spawnImpl ?? spawnChild;
    this.killImpl = options.killImpl ?? spawnChild;
    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.child = undefined;
    this.ready = undefined;
    this.starting = undefined;
    this.queue = [];
    this.pending = undefined;
    this.buffer = '';
    this.readyInfo = undefined;
    this.stderrStream = undefined;
    this.stats = { starts: 0, stops: 0, jobs: 0, failures: 0, lastMs: 0, lastError: '' };
  }

  /** The `speech.local` section. */
  config() {
    return this.store?.get?.()?.speech?.local ?? {};
  }

  /** Installation root (`E:\\feiyu`). */
  root() {
    return String(this.config().root ?? '').trim();
  }

  /** The Python with torch and CosyVoice: `<root>\\envs\\tts`. */
  pythonPath() {
    const explicit = String(this.config().ttsPython ?? '').trim();
    if (explicit !== '') return explicit;
    const root = this.root();
    return root === '' ? '' : join(root, 'envs', 'tts', 'Scripts', 'python.exe');
  }

  /** The CosyVoice release package. */
  modelPath() {
    const explicit = String(this.config().ttsModel ?? '').trim();
    if (explicit !== '') return explicit;
    const root = this.root();
    return root === '' ? '' : join(root, 'models', 'FeiyuVoice-CosyVoice3');
  }

  /** The runtime profile that pins her CosyVoice source and torch build. */
  profilePath() {
    const explicit = String(this.config().ttsProfile ?? '').trim();
    if (explicit !== '') return explicit;
    const root = this.root();
    return root === '' ? '' : join(root, 'server', 'configs', 'runtime.tts.cuda.local.json');
  }

  /** The voice service checkout (the worker imports its runtime checks). */
  serverPath() {
    const explicit = String(this.config().ttsServer ?? '').trim();
    if (explicit !== '') return explicit;
    const root = this.root();
    return root === '' ? '' : join(root, 'server');
  }

  /** The worker script shipped in this bundle. */
  scriptPath() {
    return fileURLToPath(new URL('../../python/feiyu_tts_server.py', import.meta.url));
  }

  /** Whether the resident TTS path should be used at all. */
  enabled() {
    const config = this.config();
    return config.enabled === true && config.ttsWarm === true && this.root() !== '';
  }

  /** Whether the worker is up and has finished loading. */
  isReady() {
    return this.readyInfo !== undefined && this.child !== undefined && this.child.exitCode === null;
  }

  /**
   * Start the worker if needed.
   *
   * @returns {Promise<void>} Resolves once the model is loaded.
   */
  async ensure() {
    if (this.isReady()) return;
    if (this.starting !== undefined) return this.starting;
    this.starting = this.#startOnce().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /**
   * Spawn once, wait for `ready`, and remember what the worker reported.
   *
   * @returns {Promise<void>} Resolves when ready.
   */
  async #startOnce() {
    const python = this.pythonPath();
    const root = this.root();
    const model = this.modelPath();
    const profile = this.profilePath();
    const server = this.serverPath();
    if (root === '' || python === '' || model === '' || profile === '' || server === '') {
      throw new Error('还没配置本地声音目录：在设置里填「本地声音安装目录」（例如 E:\\feiyu）。');
    }
    const script = this.scriptPath();
    const folder = join(tmpdir(), 'dsh-to-qq-tts-warm');
    await mkdir(folder, { recursive: true });
    const logPath = join(folder, 'worker.log');
    const style = String(this.config().style ?? 'cute');
    const args = ['-B', script, '--package', model, '--profile', profile, '--server', server, '--style', style];
    this.log(`starting resident TTS worker: ${python} ${args.join(' ')}`);
    const sink = createWriteStream(logPath, { flags: 'a' });
    const child = this.spawnImpl(python, args, {
      cwd: folder,
      env: { ...this.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderrStream = sink;
    child.stdout.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => sink.write(chunk));
    child.stdout.on('data', chunk => this.#onStdout(chunk));

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`常驻 TTS 进程 ${Math.round(READY_TIMEOUT_MS / 1000)} 秒还没加载好（日志 ${logPath}）`));
      }, READY_TIMEOUT_MS);
      timer.unref?.();
      this.ready = { resolve, reject, timer };
    });
    this.child = child;
    child.once('error', error => {
      this.ready?.reject(new Error(`常驻 TTS 进程起不来：${error.message}`));
      this.log(`resident TTS worker failed to spawn: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.readyInfo = undefined;
      sink.end();
      this.stderrStream = undefined;
      const error = new Error(`常驻 TTS 进程退出了（code=${code} signal=${signal}，日志 ${logPath}）`);
      this.ready?.reject(error);
      this.pending?.reject(error);
      this.ready = undefined;
      this.pending = undefined;
      this.log(`resident TTS worker exited code=${code} signal=${signal}`);
    });
    this.stats.starts += 1;
    await ready;
  }

  /**
   * Consume protocol lines from the worker.
   *
   * @param {string} chunk Raw stdout text.
   * @returns {void}
   */
  #onStdout(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.log(`resident TTS worker said something odd: ${line.slice(0, 200)}`);
        continue;
      }
      if (message.op === 'ready') {
        this.readyInfo = message;
        const entry = this.ready;
        this.ready = undefined;
        if (entry !== undefined) {
          clearTimeout(entry.timer);
          if (message.ok === true) entry.resolve(message);
          else entry.reject(new Error(message.error ?? '常驻 TTS 进程加载失败'));
        }
        continue;
      }
      const entry = this.pending;
      this.pending = undefined;
      if (entry === undefined) continue;
      clearTimeout(entry.timer);
      if (message.ok === true) entry.resolve(message);
      else entry.reject(new Error(message.error ?? `${message.op} 失败`));
    }
  }

  /**
   * Send one message; requests are serialized because the worker answers in
   * order without ids.
   *
   * @param {Record<string, any>} message Request.
   * @param {number} [timeoutMs] Reply budget.
   * @returns {Promise<any>} The reply.
   */
  #call(message, timeoutMs = REQUEST_TIMEOUT_MS) {
    const run = async () => {
      const child = this.child;
      if (child === undefined || child.exitCode !== null) throw new Error('常驻 TTS 进程没在运行');
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending?.reject === reject) this.pending = undefined;
          reject(new Error(`常驻 TTS 进程 ${Math.round(timeoutMs / 1000)} 秒没回话`));
        }, timeoutMs);
        timer.unref?.();
        this.pending = { resolve, reject, timer };
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return reply;
    };
    const next = (this.queue.at(-1) ?? Promise.resolve()).then(run, run);
    this.queue.push(next.catch(() => {}));
    if (this.queue.length > 32) this.queue.splice(0, this.queue.length - 32);
    return next;
  }

  /**
   * Speak one line in the resident process.
   *
   * @param {string} text What to say.
   * @param {{ style?: string }} [options] Voice style.
   * @returns {Promise<{ bytes: Buffer, ms: number, sampleRate: number, kind: string, style: string, seconds: number }>} A WAV.
   */
  async synthesize(text, options = {}) {
    const spoken = String(text ?? '').trim();
    if (spoken === '') throw new Error('没有要说的内容');
    await this.ensure();
    const folder = join(tmpdir(), 'dsh-to-qq-tts-warm');
    await mkdir(folder, { recursive: true });
    const output = join(folder, `synth-${Date.now()}-${process.pid}.wav`);
    try {
      const reply = await this.#call({ op: 'synth', text: spoken, style: options.style, instruct: options.instruct, output });
      const bytes = await readFile(output);
      this.stats.jobs += 1;
      this.stats.lastMs = Number(reply.ms ?? 0);
      return {
        bytes,
        ms: Number(reply.ms ?? 0),
        sampleRate: Number(reply.sample_rate ?? 24_000),
        seconds: Number(reply.seconds ?? 0),
        kind: 'tts',
        style: String(reply.style ?? options.style ?? ''),
      };
    } catch (error) {
      this.stats.failures += 1;
      this.stats.lastError = error?.message ?? String(error);
      throw error;
    } finally {
      await rm(output, { force: true }).catch(() => {});
    }
  }

  /**
   * Make sure the worker answers (starts it when needed).
   *
   * @returns {Promise<void>} Resolves once ready.
   */
  async start() {
    await this.ensure();
  }

  /** Resident process facts, cheap enough for a status tool. */
  status() {
    return {
      enabled: this.enabled(),
      ready: this.isReady(),
      running: this.child !== undefined && this.child.exitCode === null,
      pid: this.child?.pid ?? 0,
      styles: Array.isArray(this.readyInfo?.styles) ? this.readyInfo.styles : [],
      style: String(this.readyInfo?.style ?? this.config().style ?? 'cute'),
      device: String(this.readyInfo?.device ?? ''),
      loadMs: Number(this.readyInfo?.load_ms ?? 0),
      prewarmMs: Number(this.readyInfo?.prewarm_ms ?? 0),
      lastMs: this.stats.lastMs,
      lastError: this.stats.lastError,
      jobs: this.stats.jobs,
      failures: this.stats.failures,
    };
  }

  /**
   * Ask the worker for its memory footprint.
   *
   * @returns {Promise<{ rssMb: number, gpuMb: number } | undefined>} Usage, when running.
   */
  async ping() {
    if (!this.isReady()) return undefined;
    try {
      const reply = await this.#call({ op: 'ping' }, 20_000);
      return { rssMb: Number(reply.rss_mb ?? 0), gpuMb: Number(reply.gpu_mb ?? 0) };
    } catch {
      return undefined;
    }
  }

  /**
   * Stop the resident process and release its VRAM.
   *
   * @returns {Promise<{ stopped: boolean }>} Whether a process was signalled.
   */
  async stop() {
    const child = this.child;
    if (child === undefined || child.pid === undefined) {
      return { stopped: false };
    }
    this.child = undefined;
    this.stats.stops += 1;
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = this.killImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
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
    this.log('resident TTS worker stopped');
    return { stopped: true };
  }

  /** Release everything this module owns. */
  async dispose() {
    await this.stop();
    this.stderrStream?.end();
    this.stderrStream = undefined;
  }
}

/** Write a WAV next to a stable name, for callers that need a path. */
export async function writeWav(bytes, path) {
  await writeFile(path, bytes);
  return path;
}
