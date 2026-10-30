/**
 * Tier enforcement at the tool registry.
 *
 * A prompt-level instruction is not a permission boundary; these allowlists are
 * applied to the agent's own context, so a group turn physically cannot call a
 * filesystem or shell tool even if the model asks to.
 */

/**
 * Tools each tier may use. Names are intersected with what is actually
 * registered, because `tools.restrict()` rejects unknown names.
 */
export const TIER_TOOLS = {
  'owner-group': [
    'read',
    'glob',
    'grep',
    'read_image',
    'web_search',
    'web_fetch',
    'qq_send',
    'qq_history',
    'group_digest',
    'memory_card_send',
    'memory_card_get',
    'memory_note',
    'memory_persona_set',
    'memory_card_clear',
    'qq_status',
    'sticker_send',
    'emoji_send',
  ],
  member: [
    'web_search',
    'web_fetch',
    'qq_send',
    'memory_card_send',
    'memory_card_get',
    'memory_note',
    'memory_persona_set',
    'memory_card_clear',
    'sticker_send',
    'emoji_send',
  ],
  'member-group': [
    'web_search',
    'web_fetch',
    'qq_send',
    'group_digest',
    'memory_card_send',
    'memory_card_get',
    'memory_note',
    'memory_persona_set',
    'memory_card_clear',
    'sticker_send',
    'emoji_send',
  ],
};

/**
 * Remember which sessions are guest sessions, so a resumed agent can be
 * restricted again after a restart.
 */
export class GuestRegistry {
  /**
   * @param {Map<string, string>} [seed] Preloaded `sessionId -> tier` entries.
   */
  constructor(seed) {
    /** @type {Map<string, string>} */
    this.tiers = new Map(seed ?? []);
  }

  /**
   * Record that a soon-to-be-created session belongs to a tier.
   *
   * @param {string} sessionId Pre-generated session id.
   * @param {string} tier The tier name.
   */
  expect(sessionId, tier) {
    this.tiers.set(sessionId, tier);
  }

  /**
   * Read a session's tier without consuming it.
   *
   * @param {string} sessionId Session id.
   * @returns {string | undefined} The tier.
   */
  tierOf(sessionId) {
    return this.tiers.get(sessionId);
  }

  /** @returns {Record<string, string>} A plain snapshot for persistence. */
  toJSON() {
    return Object.fromEntries(this.tiers);
  }
}

/**
 * Restrict one live agent to its tier's allowlist.
 *
 * Throws when the restriction cannot be installed: failing the agent creation is
 * safer than letting an unconfined guest session run.
 *
 * @param {object} services Services needed to apply the restriction.
 * @param {any} services.tools The `ctx.tools` service.
 * @param {any} services.agent The agent being created.
 * @param {string} tier The tier name.
 * @returns {() => void} Disposer for the installed restriction.
 */
export function installTierRestriction(services, tier) {
  const wanted = TIER_TOOLS[tier];
  if (wanted === undefined) throw new Error(`unknown tier ${tier}`);

  const agentCtx = services.agent?.ctx;
  if (agentCtx === undefined || agentCtx === null) {
    throw new Error(`agent ${services.agent?.id} exposes no context; refusing to run an unrestricted guest session`);
  }

  const visible = new Set(services.tools.schemas(services.agent).map(schema => schema.name));
  const allow = wanted.filter(name => visible.has(name));
  if (allow.length === 0) {
    throw new Error(`no tier tool of ${tier} is registered; refusing to run an unrestricted guest session`);
  }

  // The restriction must be installed through the agent's own context: the
  // registry refuses a context-global restriction, because that would mask the
  // tool for every agent in the process.
  const scopedTools = agentCtx.tools;
  if (scopedTools === undefined || typeof scopedTools.restrict !== 'function') {
    throw new Error(`agent ${services.agent?.id} has no scoped tools service; refusing to run an unrestricted guest session`);
  }
  return agentCtx.effect(() => scopedTools.restrict({ allow }));
}




