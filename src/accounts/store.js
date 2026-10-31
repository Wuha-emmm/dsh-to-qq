/**
 * Optional site accounts (Bilibili, Xiaohongshu).
 *
 * A logged-in account is nothing but a cookie header here: the bridge never asks
 * for a password, never stores one, and never returns the cookie to the panel.
 * Cookies live in `accounts.json` in the state directory, not in `config.json`,
 * so a settings dump cannot leak them.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Hosts each provider's cookie may be attached to. */
const PROVIDERS = {
  bilibili: ['bilibili.com', 'b23.tv', 'bilivideo.com', 'hdslb.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'xhscdn.com'],
};

/**
 * Whether an account is configured for this provider.
 *
 * @param {any} account Stored account.
 * @returns {boolean} True when a cookie string is present.
 */
function usable(account) {
  return account !== null && typeof account === 'object'
    && typeof account.cookie === 'string' && account.cookie.trim() !== '';
}

/**
 * Cookie jar for a handful of sites, persisted as JSON.
 */
export class AccountStore {
  /**
   * @param {string} file Absolute path to accounts.json.
   */
  constructor(file) {
    this.file = file;
    /** @type {Record<string, any>} */
    this.accounts = {};
    this.loaded = false;
  }

  /** Read the file, tolerating absence and corruption. */
  async load() {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [provider, account] of Object.entries(parsed)) {
          if (PROVIDERS[provider] === undefined) continue;
          this.accounts[provider] = account;
        }
      }
    } catch {
      // Missing or unreadable starts empty.
    }
    this.loaded = true;
  }

  /** Persist the jar atomically. */
  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(this.accounts, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }

  /**
   * Store one provider's cookie.
   *
   * @param {string} provider Provider key.
   * @param {{ cookie: string, nickname?: string, uid?: number, method?: string }} data Account data.
   * @returns {Promise<void>} Resolves after the write.
   */
  async set(provider, data) {
    if (PROVIDERS[provider] === undefined) throw new Error(`unknown provider: ${provider}`);
    this.accounts[provider] = {
      cookie: String(data.cookie ?? '').trim(),
      nickname: String(data.nickname ?? '').slice(0, 60),
      uid: Number(data.uid) || 0,
      method: String(data.method ?? 'cookie').slice(0, 20),
      savedAt: Date.now(),
    };
    await this.save();
  }

  /**
   * Forget one provider.
   *
   * @param {string} provider Provider key.
   * @returns {Promise<void>} Resolves after the write.
   */
  async clear(provider) {
    delete this.accounts[provider];
    await this.save();
  }

  /**
   * Status without the secret.
   *
   * @returns {Record<string, { loggedIn: boolean, nickname: string, uid: number, method: string, savedAt: number }>} Per provider.
   */
  status() {
    const out = {};
    for (const provider of Object.keys(PROVIDERS)) {
      const account = this.accounts[provider];
      out[provider] = usable(account)
        ? {
          loggedIn: true,
          nickname: String(account.nickname ?? ''),
          uid: Number(account.uid) || 0,
          method: String(account.method ?? 'cookie'),
          savedAt: Number(account.savedAt) || 0,
        }
        : { loggedIn: false, nickname: '', uid: 0, method: '', savedAt: 0 };
    }
    return out;
  }

  /**
   * Cookie header to attach to a request, if the host belongs to a provider.
   *
   * @param {string} url Target URL.
   * @returns {string} `name=value; …` or ''.
   */
  cookieFor(url) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
    for (const [provider, suffixes] of Object.entries(PROVIDERS)) {
      if (!suffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) continue;
      const account = this.accounts[provider];
      return usable(account) ? String(account.cookie) : '';
    }
    return '';
  }
}

export { PROVIDERS };
