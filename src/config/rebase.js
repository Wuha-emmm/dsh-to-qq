/**
 * Rewrite the absolute paths in a config after moving to another machine.
 *
 * A backup carries the old machine's prefixes, so a restore on a new computer
 * leaves every path pointing at a drive that is not there. The set of path
 * settings is fixed, so rebasing is a string replacement, not a config diff.
 */

/**
 * Config keys that hold an absolute path.
 *
 * Keep this list next to the config defaults: a new path setting that is not
 * listed here silently keeps pointing at the old machine.
 */
export const PATH_KEYS = ['connection.snowlumaDir', 'conversation.cwd', 'accounts.browserPath'];

/**
 * Read one dotted path out of an object.
 *
 * @param {Record<string, any>} source Config object.
 * @param {string} dotted Dotted key.
 * @returns {string} The string value, or '' when absent or not a string.
 */
export function readPath(source, dotted) {
  let node = source;
  for (const part of dotted.split('.')) {
    if (node === null || typeof node !== 'object') return '';
    node = node[part];
  }
  return typeof node === 'string' ? node : '';
}

/**
 * Write one dotted path into an object, creating intermediate objects.
 *
 * @param {Record<string, any>} target Config object.
 * @param {string} dotted Dotted key.
 * @param {string} value New value.
 * @returns {void}
 */
export function writePath(target, dotted, value) {
  const parts = dotted.split('.');
  const last = parts.pop() ?? '';
  let node = target;
  for (const part of parts) {
    if (node[part] === null || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  node[last] = value;
}

/**
 * Replace a prefix on every path setting.
 *
 * Matching is case-insensitive because Windows treats `E:\Games` and `e:\games`
 * as the same directory, and a backup restored from another drive letter is the
 * common case this exists for.
 *
 * @param {Record<string, any>} config Config object (not modified).
 * @param {string} from Old prefix, e.g. `E:\\`.
 * @param {string} to New prefix, e.g. `F:\\`.
 * @returns {{ changes: { key: string, before: string, after: string }[], unresolved: { key: string, value: string }[] }} What changed and what still points elsewhere.
 */
export function rebasePaths(config, from, to) {
  const oldPrefix = normalizePrefix(from);
  const newPrefix = normalizePrefix(to);
  const changes = [];
  const unresolved = [];
  if (oldPrefix === '') {
    for (const key of PATH_KEYS) {
      const value = readPath(config, key);
      if (value !== '') unresolved.push({ key, value });
    }
    return { changes, unresolved };
  }

  for (const key of PATH_KEYS) {
    const value = readPath(config, key);
    if (value === '') continue;
    if (value.toLowerCase().startsWith(oldPrefix.toLowerCase())) {
      const rest = value.slice(oldPrefix.length).replace(/^[\\/]+/, '');
      changes.push({ key, before: value, after: `${newPrefix}${rest}` });
    } else if (!value.toLowerCase().startsWith(newPrefix.toLowerCase())) {
      unresolved.push({ key, value });
    }
  }
  return { changes, unresolved };
}

/**
 * Normalize a prefix to end with one separator.
 *
 * @param {string} value Raw prefix.
 * @returns {string} Prefix with a trailing backslash, or '' when empty.
 */
function normalizePrefix(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return '';
  return text.endsWith('\\') || text.endsWith('/') ? text : `${text}\\`;
}
