import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mergeConfig, defaults } from './defaults.js';

/**
 * Where this plugin keeps its runtime configuration.
 *
 * Profile-installed bundles live outside the DSH installation, so the profile
 * directory (when the Host provides it) is the only stable home.
 *
 * @param {Record<string, string | undefined>} [env] Environment to inspect.
 * @returns {string} Absolute path to config.json.
 */
export function defaultConfigPath(env = process.env) {
  const base = env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh');
  return join(base, 'dsh-to-qq', 'config.json');
}

/**
 * Reads, validates, watches, and atomically rewrites `config.json`.
 *
 * The settings page writes the same file; a watcher turns that into a live
 * `onChange` call so the Host applies changes without a restart.
 */
export class ConfigStore {
  /**
   * @param {string} file Absolute path to config.json.
   * @param {(error: Error) => void} [onError] Receives read/write failures.
   */
  constructor(file, onError) {
    this.file = file;
    this.onError = onError ?? (() => {});
    /** @type {import('./defaults.js').QQConfig} */
    this.current = defaults();
    /** @type {Set<(config: import('./defaults.js').QQConfig) => void>} */
    this.listeners = new Set();
    this.loaded = false;
    this.watching = false;
    this.lastRaw = '';
  }

  /** @returns {import('./defaults.js').QQConfig} The live configuration. */
  get() {
    return this.current;
  }

  /**
   * Load the file, creating it with defaults when absent.
   *
   * @returns {Promise<import('./defaults.js').QQConfig>} The loaded configuration.
   */
  async load() {
    let raw = '';
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.onError(error);
      await this.save(defaults(), { silent: true });
      raw = JSON.stringify(this.current, null, 2);
    }
    let parsed;
    try {
      parsed = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch (error) {
      this.onError(new Error(`config.json is not valid JSON; using defaults (${error.message})`));
      parsed = {};
    }
    this.current = mergeConfig(parsed);
    this.lastRaw = raw;
    this.loaded = true;
    return this.current;
  }

  /**
   * Persist a configuration atomically, then notify listeners.
   *
   * @param {import('./defaults.js').QQConfig} next The configuration to store.
   * @param {{ silent?: boolean }} [options] Skip the file write when seeding defaults.
   * @returns {Promise<void>}
   */
  async save(next, options = {}) {
    this.current = mergeConfig(next);
    if (options.silent === true) return;
    const body = `${JSON.stringify(this.current, null, 2)}\n`;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, this.file);
    this.lastRaw = body;
    for (const listener of this.listeners) {
      try {
        listener(this.current);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  /**
   * Apply a mutation to the current config and persist it.
   *
   * @param {(config: import('./defaults.js').QQConfig) => void} mutate In-place editor.
   * @returns {Promise<import('./defaults.js').QQConfig>} The saved configuration.
   */
  async update(mutate) {
    const draft = structuredClone(this.current);
    mutate(draft);
    await this.save(draft);
    return this.current;
  }

  /**
   * Subscribe to committed changes, including writes made by the settings page.
   *
   * @param {(config: import('./defaults.js').QQConfig) => void} listener Called after each commit.
   * @returns {() => void} Disposer.
   */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start polling the file so external writes (settings page) are picked up. */
  watch() {
    if (this.watching) return;
    this.watching = true;
    watchFile(this.file, { interval: 1000 }, async () => {
      try {
        const raw = await readFile(this.file, 'utf8');
        if (raw === this.lastRaw) return;
        this.lastRaw = raw;
        this.current = mergeConfig(raw.trim() === '' ? {} : JSON.parse(raw));
        for (const listener of this.listeners) listener(this.current);
      } catch (error) {
        this.onError(error);
      }
    });
  }

  /** Stop watching the file. */
  dispose() {
    if (!this.watching) return;
    this.watching = false;
    unwatchFile(this.file);
    this.listeners.clear();
  }
}
