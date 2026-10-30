/**
 * Two-step confirmation for dangerous tool calls made from QQ.
 *
 * A denial is not an approval prompt: the guard refuses the call and tells the
 * model what to ask the administrator. `/yes` in the QQ conversation then grants
 * that one tool for a short window, and the administrator asks again.
 */

/** Tool names that always need a confirmation when called from QQ. */
export const DANGEROUS_TOOLS = new Set(['write', 'edit', 'pwsh', 'plugin_manager']);

/** Pending requests and short-lived grants, keyed by scene. */
export class Approvals {
  /**
   * @param {number} [ttlMs] How long a grant stays valid.
   */
  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
    /** @type {Map<string, { tool: string, at: number }>} */
    this.pending = new Map();
    /** @type {Map<string, { tool: string, until: number }>} */
    this.granted = new Map();
  }

  /**
   * Remember what the model tried to do.
   *
   * @param {string} scene Scene key.
   * @param {string} tool Tool name.
   * @returns {void}
   */
  request(scene, tool) {
    this.pending.set(scene, { tool, at: Date.now() });
  }

  /**
   * Approve the pending request of a scene.
   *
   * @param {string} scene Scene key.
   * @returns {string | undefined} The tool that was approved, when something was pending.
   */
  grant(scene) {
    const pending = this.pending.get(scene);
    if (pending === undefined) return undefined;
    this.pending.delete(scene);
    this.granted.set(scene, { tool: pending.tool, until: Date.now() + this.ttlMs });
    return pending.tool;
  }

  /**
   * Whether this tool may run now.
   *
   * @param {string} scene Scene key.
   * @param {string} tool Tool name.
   * @param {number} [now] Epoch milliseconds.
   * @returns {boolean} True when a fresh grant covers it.
   */
  allowed(scene, tool, now = Date.now()) {
    const granted = this.granted.get(scene);
    if (granted === undefined) return false;
    if (now > granted.until) {
      this.granted.delete(scene);
      return false;
    }
    return granted.tool === tool;
  }

  /**
   * @param {string} scene Scene key.
   * @returns {{ tool: string, at: number } | undefined} The pending request.
   */
  pendingOf(scene) {
    return this.pending.get(scene);
  }
}
