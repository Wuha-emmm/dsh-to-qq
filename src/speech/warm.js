/**
 * Resident RVC worker: pay the CUDA startup once, then convert in ~0.15 s.
 *
 * The release service runs one engine process per job (about ten seconds a
 * sentence on this machine, almost all of it process and CUDA startup). This
 * module keeps a single engine process alive instead, and killing it is what
 * frees the VRAM again, so the switch and the memory cost stay in lockstep.
 *
 * The worker is `python/feiyu_warm_server.py`, shipped inside this bundle: it
 * speaks newline-delimited JSON on stdin/stdout and prints `{"op":"ready"}`
 * once the model is loaded and prewarmed.
 */

import { spawn as spawnChild } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const READY_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * The resident worker process, its protocol, and the files it needs.
 */
export class WarmVoice {
  /**
   * @param {object} options Wiring.
   * @param {import('../config/store.js').ConfigStore} options.store Live configuration.
   * @param {(line: string) => void} [options.log] Diagnostic sink.
   * @param {Record<string, string | undefined>} [options.env] Environment for the child.
   * @param {typeof spawnChild} [options.spawnImpl] Injectable spawn, for tests.
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
    this.spawnImpl = options.spawnImpl ?? spawnChild;
    this.killImpl = options.killImpl ?? spawnChild;
    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.child = undefined;
    this.ready = undefined;
    this.starting = undefined;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.readyInfo = undefined;
    this.stderrStream = undefined;
    this.idleTimer = undefined;
    this.stats = { starts: 0, stops: 0, jobs: 0, failures: 0, lastError: '', lastMs: 0 };
  }

  /** The `speech.local` section. */
  config() {
    return this.store?.get?.()?.speech?.local ?? {};
  }

  /** Installation root (`E:\\feiyu`). */
  root() {
    return String(this.config().root ?? '').trim();
  }

  /** The Python that has torch and the engines: `<root>\\envs\\rvc`. */
  pythonPath() {
    const explicit = String(this.config().warmPython ?? '').trim();
    if (explicit !== '') return explicit;
    const root = this.root();
    return root === '' ? '' : join(root, 'envs', 'rvc', 'Scripts', 'python.exe');
  }

  /** The RVC release package. */
  packagePath() {
    const explicit = String(this.config().warmPackage ?? '').trim();
    if (explicit !== '') return explicit;
    const root = this.root();
    return root === '' ? '' : join(root, 'models', 'FeiyuVoice-RVC');
  }

  /** The worker script shipped in this bundle. */
  scriptPath() {
    return fileURLToPath(new URL('../../python/feiyu_warm_server.py', import.meta.url));
  }

  /** Whether the resident path should be used at all. */
  enabled() {
    const config = this.config();
    return config.enabled === true && config.warm !== false && this.root() !== '';
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
    if (root === '' || python === '') {
      throw new Error('还没配置本地声音目录：在设置里填「本地声音安装目录」（例如 E:\\feiyu）。');
    }
    const script = this.scriptPath();
    const folder = join(tmpdir(), 'dsh-to-qq-warm');
    await mkdir(folder, { recursive: true });
    const logPath = join(folder, 'worker.log');
    const args = ['-B', script, '--root', root];
    this.log(`starting resident RVC worker: ${python} ${args.join(' ')}`);
    const sink = createWriteStream(logPath, { flags: 'a' });
    const child = this.spawnImpl(python, args, {
      cwd: dirname(script),
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
        reject(new Error(`常驻进程 ${Math.round(READY_TIMEOUT_MS / 1000)} 秒还没加载好（日志 ${logPath}）`));
      }, READY_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set('ready', {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.child = child;
    child.once('error', error => {
      this.pending.get('ready')?.reject(new Error(`常驻进程起不来：${error.message}`));
      this.log(`resident RVC worker failed to spawn: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.readyInfo = undefined;
      sink.end();
      this.stderrStream = undefined;
      const error = new Error(`常驻进程退出了（code=${code} signal=${signal}，日志 ${logPath}）`);
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
      this.log(`resident RVC worker exited code=${code} signal=${signal}`);
    });
    this.stats.starts += 1;
    await ready;
    this.log(
      `resident RVC worker ready in ${this.readyInfo?.load_ms ?? '?'}ms `
      + `(prewarm ${this.readyInfo?.prewarm_ms ?? '?'}ms, ${this.readyInfo?.device ?? '?'})`,
    );
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
        this.log(`resident RVC worker said something odd: ${line.slice(0, 200)}`);
        continue;
      }
      if (message.op === 'ready') {
        this.readyInfo = message;
        const entry = this.pending.get('ready');
        this.pending.delete('ready');
        entry?.resolve(message);
        continue;
      }
      const entry = this.pending.get(message.id);
      if (entry === undefined) continue;
      this.pending.delete(message.id);
      if (message.ok === true) entry.resolve(message);
      else entry.reject(new Error(message.error ?? `${message.op} 失败`));
    }
  }

  /**
   * Send one request and wait for its reply.
   *
   * @param {Record<string, any>} message Request without an id.
   * @param {number} timeoutMs Reply budget.
   * @returns {Promise<any>} The reply.
   */
  #call(message, timeoutMs = REQUEST_TIMEOUT_MS) {
    const child = this.child;
    if (child === undefined || child.exitCode !== null) {
      throw new Error('常驻进程没在运行');
    }
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`常驻进程 ${Math.round(timeoutMs / 1000)} 秒没回话`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    return promise;
  }

  /**
   * Convert one recording to her timbre in the resident process.
   *
   * @param {Buffer} wav Source audio.
   * @param {{ name?: string }} [options] Upload name, for the temp file.
   * @returns {Promise<{ bytes: Buffer, ms: number, sampleRate: number, kind: string }>} A WAV.
   */
  async convert(wav, options = {}) {
    await this.ensure();
    const folder = join(tmpdir(), 'dsh-to-qq-warm');
    await mkdir(folder, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const input = join(folder, `${stamp}-in.wav`);
    const output = join(folder, `${stamp}-out.wav`);
    await writeFile(input, wav);
    const started = Date.now();
    try {
      const reply = await this.#call({ op: 'convert', input, output });
      const bytes = await readFile(output);
      if (bytes.length === 0) throw new Error('常驻进程产出了空音频');
      const ms = Date.now() - started;
      this.stats.jobs += 1;
      this.stats.lastMs = ms;
      this.lastJobAt = Date.now();
      this.#armIdle();
      this.log(`resident RVC converted ${reply.seconds ?? '?'}s audio in ${ms}ms (${bytes.length}B @ ${reply.sample_rate ?? '?'}Hz)`);
      return { bytes, ms, sampleRate: Number(reply.sample_rate ?? 40000), kind: 'rvc' };
    } catch (error) {
      this.stats.failures += 1;
      this.stats.lastError = error.message;
      throw error;
    } finally {
      await rm(input, { force: true });
      await rm(output, { force: true });
    }
  }

  /**
   * Ask the worker how it is doing without loading anything.
   *
   * @returns {Promise<{ rssMb: number, gpuMb: number } | undefined>} Usage, when up.
   */
  async ping() {
    if (!this.isReady()) return undefined;
    try {
      const reply = await this.#call({ op: 'ping' }, 10_000);
      return { rssMb: Number(reply.rss_mb ?? 0), gpuMb: Number(reply.gpu_mb ?? 0) };
    } catch {
      return undefined;
    }
  }

  /**
   * What the switch page shows.
   *
   * @returns {Promise<{ mode: string, running: boolean, ready: boolean, pid: number, device: string, loadMs: number, prewarmMs: number, jobs: number, lastMs: number }>} Status.
   */
  status() {
    return {
      mode: 'warm',
      running: this.child !== undefined && this.child.exitCode === null,
      ready: this.isReady(),
      pid: this.child?.pid ?? 0,
      device: String(this.readyInfo?.device ?? ''),
      loadMs: Number(this.readyInfo?.load_ms ?? 0),
      prewarmMs: Number(this.readyInfo?.prewarm_ms ?? 0),
      jobs: this.stats.jobs,
      lastMs: this.stats.lastMs,
      lastError: this.stats.lastError,
    };
  }

  /**
   * Kill the worker, which is what frees the GPU memory.
   *
   * @returns {Promise<{ stopped: boolean }>} Whether a process was signalled.
   */
  async stop() {
    this.#clearIdle();
    const child = this.child;
    if (child === undefined || child.pid === undefined) {
      return { stopped: false };
    }
    this.child = undefined;
    this.readyInfo = undefined;
    try {
      if (process.platform === 'win32') {
        await new Promise(resolve => {
          const killer = this.killImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.once('exit', () => resolve(undefined));
          killer.once('error', () => resolve(undefined));
        });
      } else {
        child.kill('SIGTERM');
      }
    } catch (error) {
      this.log(`resident stop failed: ${error.message}`);
    }
    this.stats.stops += 1;
    this.log('resident RVC worker stopped; GPU memory released');
    return { stopped: true };
  }

  /** Arm the idle stop, like the service path does. */
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

  /** Drop the idle timer. */
  #clearIdle() {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Release everything this module owns. */
  async dispose() {
    await this.stop();
    this.stderrStream?.end();
  }
}
