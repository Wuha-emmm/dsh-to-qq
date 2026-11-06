/**
 * QQ avatars for the conversation list.
 *
 * OneBot carries no avatar field, but QQ publishes portraits by id. The panel
 * asks this module for a scene, and the module keeps the bytes on disk so a
 * five-second list poll does not hit qlogo.cn, and a restart or an offline
 * transport still shows the last faces it had.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectMediaType } from '../media/inbound.js';
import { parseSceneKey } from '../bridge/scene-names.js';

/** Requested portrait edge, in pixels; enough for a 34px row on HiDPI. */
const AVATAR_PIXELS = 100;
/** Refetch a cached portrait after this long. */
const FRESH_MS = 24 * 60 * 60 * 1000;
/** Refuse a response larger than this; real portraits are a few KB. */
const MAX_BYTES = 512 * 1024;
/** Give up on qlogo.cn after this long so the panel is never held hostage. */
const FETCH_TIMEOUT_MS = 6000;

/**
 * The public portrait URL for a scene.
 *
 * @param {string} scene Scene key.
 * @returns {string} URL, or an empty string outside valid scenes.
 */
export function avatarUrlFor(scene) {
  const parsed = parseSceneKey(scene);
  if (parsed === undefined) return '';
  return parsed.kind === 'group'
    ? `https://p.qlogo.cn/gh/${parsed.id}/${parsed.id}/${AVATAR_PIXELS}`
    : `https://q1.qlogo.cn/g?b=qq&nk=${parsed.id}&s=${AVATAR_PIXELS}`;
}

/** Disk cache of scene portraits. */
export class AvatarCache {
  /**
   * @param {string} dir Directory holding `{kind}-{id}.img` files.
   * @param {{ fetch?: typeof fetch, log?: (line: string) => void }} [options] Test seams.
   */
  constructor(dir, options = {}) {
    this.dir = dir;
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.log = options.log ?? (() => {});
    /** @type {Map<string, Promise<{ bytes: Uint8Array, type: string } | undefined>>} */
    this.inflight = new Map();
  }

  /**
   * Read one portrait, refreshing it from QQ when the copy is old.
   *
   * @param {string} scene Scene key.
   * @returns {Promise<{ bytes: Uint8Array, type: string } | undefined>} Image, or undefined.
   */
  async get(scene) {
    const parsed = parseSceneKey(scene);
    if (parsed === undefined) return undefined;
    const key = `${parsed.kind}-${parsed.id}`;
    const path = join(this.dir, `${key}.img`);
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && Date.now() - info.mtimeMs < FRESH_MS) {
      const cached = await readFile(path).catch(() => undefined);
      if (cached !== undefined && cached.length > 0) {
        const bytes = new Uint8Array(cached);
        return { bytes, type: detectMediaType(bytes, '') };
      }
    }
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const task = this.#refresh(scene, path, info !== undefined)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  /**
   * Download one portrait and swap it into place.
   *
   * @param {string} scene Scene key.
   * @param {string} path Destination file.
   * @param {boolean} hasStale Whether a previous copy exists on disk.
   * @returns {Promise<{ bytes: Uint8Array, type: string } | undefined>} Image, or undefined.
   */
  async #refresh(scene, path, hasStale) {
    const stale = hasStale ? await readFile(path).catch(() => undefined) : undefined;
    try {
      const response = await this.fetch(avatarUrlFor(scene), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
          referer: 'https://qzone.qq.com/',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length === 0) throw new Error('empty avatar');
      if (buffer.length > MAX_BYTES) throw new Error(`avatar is ${buffer.length} bytes`);
      const type = detectMediaType(buffer, response.headers.get('content-type'));
      await mkdir(this.dir, { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, buffer);
      await rename(temp, path);
      return { bytes: buffer, type };
    } catch (error) {
      if (stale !== undefined && stale.length > 0) {
        this.log(`avatar ${scene} refresh failed (${error?.message ?? error}); serving the cached copy`);
        const bytes = new Uint8Array(stale);
        return { bytes, type: detectMediaType(bytes, '') };
      }
      this.log(`avatar ${scene} unavailable: ${error?.message ?? error}`);
      return undefined;
    }
  }
}
