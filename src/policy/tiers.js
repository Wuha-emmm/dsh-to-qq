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
/**
 * First blocked word contained in a text, or an empty string.
 *
 * Used for the message body and for everything merged into the prompt later
 * (quote, forward, voice transcript, file names): a word filter that only reads
 * `message.text` lets every attachment through.
 *
 * @param {string} text Text to scan.
 * @param {any} config Live configuration.
 * @returns {string} The matched word, or ''.
 */
export function blockedWord(text, config) {
  const words = Array.isArray(config?.access?.blockedWords) ? config.access.blockedWords : [];
  const body = String(text ?? '');
  if (body === '') return '';
  for (const word of words) {
    if (typeof word !== 'string' || word === '') continue;
    if (body.includes(word)) return word;
  }
  return '';
}

export function admit(message, config) {
  const access = config.access;
  const isAdmin = access.admins.some(admin => admin.qq === message.senderId);

  if (blockedWord(message.text, config) !== '') return { accepted: false, reason: 'blocked-word' };

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
 * @returns {boolean} True only for the owner's private chat, where filesystem tools exist.
 */
export function mayRead(tier) {
  return tier === 'owner';
}



