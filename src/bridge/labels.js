/**
 * Human labels for QQ scenes.
 *
 * The group name is fetched from the transport, with a stable fallback to the
 * group number so a card never ends up with an empty label.
 */

/**
 * Format the pill text for a group.
 *
 * @param {number} gid Group id.
 * @param {string} [name] Group name when known.
 * @returns {string} `群 · 名称` or `群 123456`.
 */
export function formatGroupLabel(gid, name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed === '' ? `群 ${gid}` : `群 · ${trimmed}`;
}

/**
 * Ask the transport for a group name.
 *
 * @param {{ call: (action: string, params: object, options?: object) => Promise<any> } | undefined} client OneBot client.
 * @param {number} gid Group id.
 * @returns {Promise<string>} The name, or an empty string.
 */
export async function fetchGroupName(client, gid) {
  if (client === undefined || !Number.isInteger(gid) || gid <= 0) return '';
  try {
    const info = await client.call('get_group_info', { group_id: gid }, { timeoutMs: 5000 });
    const name = info?.group_name ?? info?.data?.group_name ?? '';
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/**
 * The pill text for a scene key.
 *
 * @param {{ call: (action: string, params: object, options?: object) => Promise<any> } | undefined} client OneBot client.
 * @param {string} scene Scene key.
 * @returns {Promise<string>} Label text, or an empty string outside groups.
 */
export async function sceneLabelFor(client, scene) {
  if (typeof scene !== 'string' || !scene.startsWith('group:')) return '';
  const gid = Number(scene.slice(scene.indexOf(':') + 1));
  const name = await fetchGroupName(client, gid);
  return formatGroupLabel(gid, name);
}
