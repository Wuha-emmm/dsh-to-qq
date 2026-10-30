/**
 * Merge a settings-page payload into the live configuration.
 *
 * The panel never receives secrets, so a naive spread of its `connection`
 * section would delete the stored tokens and silently take the bridge offline.
 * Merge per section, and treat a missing or masked token as "keep what we have".
 */

/** Sections the settings surface may write. */
const SECTION_KEYS = ['connection', 'access', 'models', 'conversation', 'memory', 'limits', 'output', 'archive', 'digest', 'safety', 'ui'];

/** Placeholder the panel uses when it knows a token exists but not its value. */
const MASK = '***';

/**
 * Merge one settings payload over the current configuration.
 *
 * @param {import('./defaults.js').QQConfig} current The live configuration.
 * @param {unknown} incoming The panel payload.
 * @returns {import('./defaults.js').QQConfig} A new configuration object.
 */
export function mergeIncomingConfig(current, incoming) {
  if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) return structuredClone(current);

  /** @type {any} */
  const next = structuredClone(current);
  for (const key of SECTION_KEYS) {
    const patch = incoming[key];
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) continue;
    next[key] = { ...next[key], ...patch };
  }

  // Secrets are write-only: keep the stored value unless the payload carries a
  // real replacement.
  for (const field of ['token', 'httpToken']) {
    const patch = next.connection[field];
    const usable = typeof patch === 'string' && patch !== '' && patch !== MASK;
    next.connection[field] = usable ? patch : current.connection[field];
  }
  delete next.connection.tokenSet;
  delete next.connection.httpTokenSet;
  return next;
}
