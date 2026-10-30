/**
 * dsh-pet integration.
 *
 * dsh-pet exposes a local HTTP API under `/dsh-pet-7340`. We use three parts of
 * it: a right-click menu entry that opens the QQ panel, work-status so the pet
 * reacts while a turn runs, and a short bubble when a QQ message arrives.
 *
 * Everything here is best-effort: dsh-pet is optional and may not be installed,
 * so every call fails quietly.
 */

/** How long to wait for the pet's long poll before retrying. */
const MENU_WAIT_MS = 25_000;

/** How long a broadcast bubble stays up. */
const BUBBLE_MS = 4_000;

/** Client for the dsh-pet HTTP surface. */
export class PetClient {
  /**
   * @param {object} options Wiring.
   * @param {string} options.origin DSH web origin, such as `http://127.0.0.1:3080`.
   * @param {string} options.petId Pet instance id, usually `main`.
   * @param {string} options.owner Menu owner key; also the panel identity.
   * @param {(line: string) => void} options.log Diagnostic sink.
   */
  constructor(options) {
    this.origin = options.origin;
    this.petId = options.petId;
    this.owner = options.owner;
    this.log = options.log;
    this.base = `${options.origin.replace(/\/$/, '')}/dsh-pet-7340`;
    this.lockId = undefined;
    this.lockExpires = 0;
  }

  /**
   * Read the pet's normalized position on screen.
   *
   * @returns {Promise<{ x: number, y: number, facing?: string } | undefined>} 0..1 coordinates, when known.
   */
  async pose() {
    try {
      const response = await fetch(`${this.base}/pose?pet=${encodeURIComponent(this.petId)}`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return undefined;
      const payload = await response.json();
      if (payload?.ok !== true) return undefined;
      const x = Number(payload.x);
      const y = Number(payload.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
      return { x, y, facing: typeof payload.facing === 'string' ? payload.facing : undefined };
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the pet is running.
   *
   * @returns {Promise<boolean>} True when `/state` answers.
   */
  async available() {
    try {
      const response = await fetch(`${this.base}/state`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Register (or replace) our right-click menu entry.
   *
   * @param {string[]} labels Menu labels.
   * @returns {Promise<boolean>} True when accepted.
   */
  async registerMenu(labels) {
    try {
      const response = await fetch(`${this.base}/menu/item`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: this.owner, labels, target: 'both' }),
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Long-poll for menu clicks and report every trigger.
   *
   * @param {(label: string) => void} onTrigger Called once per click.
   * @param {AbortSignal} signal Stops the loop.
   * @returns {Promise<void>} Resolves when the loop ends.
   */
  async pollMenu(onTrigger, signal) {
    while (!signal.aborted) {
      try {
        const response = await fetch(`${this.base}/menu/events?owner=${encodeURIComponent(this.owner)}&wait=${MENU_WAIT_MS}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(MENU_WAIT_MS + 5000)]),
        });
        if (!response.ok) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }
        const payload = await response.json();
        const events = payload?.events ?? {};
        for (const [label, petId] of Object.entries(events)) {
          if (petId !== null && petId !== undefined) onTrigger(label);
        }
      } catch {
        if (signal.aborted) return;
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  /**
   * Report this plugin's work state to the pet.
   *
   * @param {'idle' | 'thinking' | 'working' | 'success' | 'error'} state The state.
   * @param {string} [task] One line describing the task.
   * @returns {Promise<void>} Resolves after the best-effort call.
   */
  async workStatus(state, task) {
    try {
      if (state === 'idle') {
        await fetch(`${this.base}/work-status`, { method: 'DELETE', signal: AbortSignal.timeout(2000) });
        return;
      }
      await fetch(`${this.base}/work-status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, task: task ?? null }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // The pet may be closed; that is not our problem.
    }
  }

  /**
   * Ensure we hold the pet's lock, renewing it when it is about to expire.
   *
   * @returns {Promise<string | undefined>} The lock id, when held.
   */
  async ensureLock() {
    if (this.lockId !== undefined && this.lockExpires - Date.now() > 5000) return this.lockId;
    try {
      const response = await fetch(`${this.base}/lock?pet=${encodeURIComponent(this.petId)}&surface=both`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(3000),
      });
      const payload = await response.json();
      if (payload?.ok === true) {
        this.lockId = payload.lockId;
        this.lockExpires = Number(payload.expiresAt) || 0;
        return this.lockId;
      }
    } catch {
      // Fall through: no lock means no bubble.
    }
    return undefined;
  }

  /**
   * Release the lock if we hold one.
   *
   * @returns {Promise<void>} Resolves after the best-effort call.
   */
  async releaseLock() {
    if (this.lockId === undefined) return;
    const lockId = this.lockId;
    this.lockId = undefined;
    try {
      await fetch(`${this.base}/lock/release?pet=${encodeURIComponent(this.petId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lockId }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // Ignore: the lock expires by itself.
    }
  }

  /**
   * Show one bubble with the given text.
   *
   * @param {string} text Bubble text.
   * @returns {Promise<void>} Resolves after the best-effort call.
   */
  async say(text) {
    const lockId = await this.ensureLock();
    if (lockId === undefined) return;
    try {
      await fetch(`${this.base}/broadcast?pet=${encodeURIComponent(this.petId)}&lock=${encodeURIComponent(lockId)}&surface=both`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, durationMs: BUBBLE_MS }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // A dropped bubble is cosmetic.
    }
  }
}
