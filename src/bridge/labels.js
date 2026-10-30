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

/**
 * Display name for one QQ number.
 *
 * Order: the card's stored name, an already known sender name, then the
 * transport (group card / nickname). Returns '' when nothing is known, and the
 * caller falls back to the bare QQ number.
 *
 * @param {{ client?: any, memory?: any }} bridge Bridge with client and memory.
 * @param {number} qq Target QQ number.
 * @param {string} [known] Name already stored on the memory card.
 * @param {string} [scene] Current scene key, used to pick the group query.
 * @returns {Promise<string>} Display name, possibly empty.
 */
export async function resolveName(bridge, qq, known, scene) {
  const stored = String(known ?? '').trim();
  if (stored !== '') return stored;
  const fromMemory = String(bridge?.memory?.get?.(qq)?.name ?? '').trim();
  if (fromMemory !== '') return fromMemory;
  const client = bridge?.client;
  if (client === undefined || !Number.isInteger(qq) || qq <= 0) return '';
  try {
    if (typeof scene === 'string' && scene.startsWith('group:')) {
      const gid = Number(scene.slice(scene.indexOf(':') + 1));
      const info = await client.call('get_group_member_info', { group_id: gid, user_id: qq, no_cache: false }, { timeoutMs: 5000 });
      const name = info?.card ?? info?.data?.card ?? info?.nickname ?? info?.data?.nickname ?? '';
      return typeof name === 'string' ? name.trim() : '';
    }
    const info = await client.call('get_stranger_info', { user_id: qq, no_cache: false }, { timeoutMs: 5000 });
    const name = info?.nickname ?? info?.data?.nickname ?? info?.card ?? info?.data?.card ?? '';
    return typeof name === 'string' ? name.trim() : '';
  } catch {
    return '';
  }
}
