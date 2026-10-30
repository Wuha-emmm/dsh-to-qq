/**
 * Access policy: who is talking, and whether the bridge should answer at all.
 *
 * The tier belongs to the sender of each message, never to the session: a group
 * chat bound to an administrator still runs at the group tier.
 */

/** @typedef {'owner' | 'owner-group' | 'member' | 'member-group'} Tier */

/**
 * Resolve the tier for one inbound message.
 *
 * @param {{ kind: 'dm' | 'group', senderId: number }} message Normalized message.
 * @param {{ admins: { qq: number }[] }} access Configuration `access` section.
 * @returns {Tier} The sender's tier.
 */
export function tierOf(message, access) {
  const isAdmin = access.admins.some(admin => admin.qq === message.senderId);
  if (message.kind === 'dm') return isAdmin ? 'owner' : 'member';
  return isAdmin ? 'owner-group' : 'member-group';
}

/**
 * Decide whether a message should reach the model at all.
 *
 * Private chats are answered for known principals; groups only when the bot is
 * mentioned and the group passes the configured mode.
 *
 * @param {import('./events.js').QQMessage} message Normalized message.
 * @param {import('../config/defaults.js').QQConfig} config Full configuration.
 * @returns {{ accepted: boolean, reason?: string }} The decision.
 */
export function admit(message, config) {
  const access = config.access;
  const isAdmin = access.admins.some(admin => admin.qq === message.senderId);

  const blocked = Array.isArray(access.blockedWords) ? access.blockedWords : [];
  if (blocked.some(word => word !== '' && message.text.includes(word))) {
    return { accepted: false, reason: 'blocked-word' };
  }

  if (message.kind === 'dm') {
    if (isAdmin) return { accepted: true };
    if (access.strangerPolicy === 'ignore') return { accepted: false, reason: 'stranger-ignored' };
    if (access.strangerPolicy === 'notice') return { accepted: false, reason: 'stranger-notice' };
    return { accepted: false, reason: 'stranger-blocked' };
  }

  const groupId = message.groupId ?? 0;
  if (access.groupMode === 'blacklist' && access.groups.includes(groupId)) {
    return { accepted: false, reason: 'group-blacklisted' };
  }
  if (access.groupMode === 'whitelist' && !access.groups.includes(groupId)) {
    return { accepted: false, reason: 'group-not-whitelisted' };
  }
  if (access.mentionOnly && !message.mentionsBot) {
    return { accepted: false, reason: 'not-mentioned' };
  }
  return { accepted: true };
}

/**
 * Whether a tier may write to the host (private owner only).
 *
 * @param {Tier} tier The sender's tier.
 * @returns {boolean} True when host writes and command execution are allowed.
 */
export function mayWrite(tier) {
  return tier === 'owner';
}

/**
 * Whether a tier may read the host filesystem.
 *
 * @param {Tier} tier The sender's tier.
 * @returns {boolean} True for the owner in private or in a group.
 */
export function mayRead(tier) {
  return tier === 'owner' || tier === 'owner-group';
}

/**
 * Tool allowlist for one tier, applied with `ctx.tools.restrict()`.
 *
 * @param {Tier} tier The sender's tier.
 * @returns {string[]} Tool names the tier may use.
 */
export function allowedTools(tier) {
  const chat = ['web_search', 'web_fetch'];
  const read = ['read', 'glob', 'grep', 'read_image'];
  const memory = ['memory_card_get', 'memory_persona_set', 'memory_card_clear'];
  const send = ['qq_send'];
  if (tier === 'owner') return [...chat, ...read, ...memory, ...send, 'qq_action', 'qq_history', 'qq_resend'];
  if (tier === 'owner-group') return [...chat, ...read, ...memory, ...send, 'qq_history'];
  return [...chat, ...memory, ...send];
}

