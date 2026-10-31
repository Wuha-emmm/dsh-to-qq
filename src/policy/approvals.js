/**
 * Two-step confirmation for dangerous tool calls made from QQ.
 *
 * A denial is not an approval prompt: the guard refuses the call and tells the
 * model what to ask the administrator. `/yes` in the QQ conversation then
 * approves **that exact call** — same tool, same arguments — for a short window.
 *
 * Approving the call signature instead of just the tool name matters: a tool
 * grant of `pwsh` for 60 seconds is a shell window, while a grant of
 * `pwsh { command: "git status" }` is one command.
 */

/** Tool names that always need a confirmation when called from QQ. */
export const DANGEROUS_TOOLS = new Set(['write', 'edit', 'pwsh', 'plugin_manager']);

/** How long an unapproved request stays answerable. */
const PENDING_TTL_MS = 5 * 60_000;

/**
 * Stable text for one tool call's arguments.
 *
 * Key order is normalized so an identical call produces an identical signature
 * even when the model serializes the object differently.
 *
 * @param {unknown} args Raw arguments (string or object).
 * @returns {string} Signature text, at most 2 KB.
 */
export function callSignature(args) {
  let value = args;
  if (typeof value === 'string') {
    const raw = value.trim();
    if (raw === '') return '';
    try {
      value = JSON.parse(raw);
    } catch {
      return raw.slice(0, 2048);
    }
  }
  if (value === null || typeof value !== 'object') return String(value ?? '').slice(0, 2048);
  const seen = new WeakSet();
  const normalize = input => {
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input)) return '[circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map(normalize);
    const out = {};
    for (const key of Object.keys(input).sort()) out[key] = normalize(input[key]);
    return out;
  };
  try {
    return JSON.stringify(normalize(value)).slice(0, 2048);
  } catch {
    return String(args).slice(0, 2048);
  }
}

/** Pending requests and short-lived grants, keyed by scene. */
export class Approvals {
  /**
   * @param {number} [ttlMs] How long a grant stays valid.
   * @param {number} [pendingTtlMs] How long a pending request stays answerable.
   */
  constructor(ttlMs = 60_000, pendingTtlMs = PENDING_TTL_MS) {
    this.ttlMs = ttlMs;
    this.pendingTtlMs = pendingTtlMs;
    /** @type {Map<string, { tool: string, signature: string, at: number, preview: string }>} */
    this.pending = new Map();
    /** @type {Map<string, { tool: string, signature: string, until: number }>} */
    this.granted = new Map();
    /** @type {Map<string, { tool: string, until: number }>} Override that covers any arguments. */
    this.toolGrants = new Map();
  }

  /**
   * Remember what the model tried to do.
   *
   * @param {string} scene Scene key.
   * @param {string} tool Tool name.
   * @param {unknown} args Arguments of the attempted call.
   * @returns {void}
   */
  request(scene, tool, args) {
    this.pending.set(scene, {
      tool,
      signature: callSignature(args),
      preview: previewOf(args),
      at: Date.now(),
    });
  }

  /**
   * Approve the pending request of a scene.
   *
   * @param {string} scene Scene key.
   * @param {number} [now] Epoch milliseconds.
   * @returns {{ tool: string, preview: string } | undefined} What was approved, when it was still valid.
   */
  grant(scene, now = Date.now()) {
    const pending = this.pending.get(scene);
    this.pending.delete(scene);
    if (pending === undefined) return undefined;
    if (now - pending.at > this.pendingTtlMs) return undefined;
    this.granted.set(scene, { tool: pending.tool, signature: pending.signature, until: now + this.ttlMs });
    return { tool: pending.tool, preview: pending.preview };
  }

  /**
   * Whether this exact call may run now.
   *
   * @param {string} scene Scene key.
   * @param {string} tool Tool name.
   * @param {unknown} args Arguments of the call about to run.
   * @param {number} [now] Epoch milliseconds.
   * @returns {boolean} True when a fresh grant covers this call.
   */
  allowed(scene, tool, args, now = Date.now()) {
    const broad = this.toolGrants.get(scene);
    if (broad !== undefined) {
      if (now > broad.until) this.toolGrants.delete(scene);
      else if (broad.tool === tool) return true;
    }
    const granted = this.granted.get(scene);
    if (granted === undefined) return false;
    if (now > granted.until) {
      this.granted.delete(scene);
      return false;
    }
    if (granted.tool !== tool) return false;
    return granted.signature === callSignature(args);
  }

  /**
   * Approve every call of one tool for a short window (the `/yes!` shortcut).
   *
   * @param {string} scene Scene key.
   * @param {string} tool Tool name.
   * @param {number} [ttlMs] How long the override lasts.
   * @returns {{ tool: string, until: number }} The override.
   */
  grantTool(scene, tool, ttlMs = 5 * 60_000) {
    const until = Date.now() + Math.max(10_000, Number(ttlMs) || 0);
    this.toolGrants.set(scene, { tool, until });
    this.pending.delete(scene);
    return { tool, until };
  }

  /** @param {string} scene Scene key. @returns {void} */
  drop(scene) {
    this.pending.delete(scene);
    this.granted.delete(scene);
    this.toolGrants.delete(scene);
  }

  /**
   * @param {string} scene Scene key.
   * @param {number} [now] Epoch milliseconds.
   * @returns {{ tool: string, at: number, preview: string } | undefined} The still-valid pending request.
   */
  pendingOf(scene, now = Date.now()) {
    const pending = this.pending.get(scene);
    if (pending === undefined) return undefined;
    if (now - pending.at > this.pendingTtlMs) {
      this.pending.delete(scene);
      return undefined;
    }
    return { tool: pending.tool, at: pending.at, preview: pending.preview };
  }
}

/**
 * Short human-readable preview of one call, for the confirmation message.
 *
 * @param {unknown} args Raw arguments.
 * @returns {string} At most 80 characters.
 */
function previewOf(args) {
  const parsed = typeof args === 'string' ? safeParse(args) : args;
  if (parsed !== null && typeof parsed === 'object' && typeof parsed.command === 'string') {
    const command = parsed.command.replace(/\s+/g, ' ').trim();
    return command.length > 60 ? `${command.slice(0, 57)}…` : command;
  }
  const signature = callSignature(args);
  if (signature === '') return '(无参数)';
  return signature.length > 60 ? `${signature.slice(0, 57)}…` : signature;
}

/**
 * Parse a JSON string without throwing.
 *
 * @param {string} text Raw text.
 * @returns {any} Parsed value, or null.
 */
function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
