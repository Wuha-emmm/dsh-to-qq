/**
 * Memory tools exposed to the model.
 *
 * Every tool resolves the QQ number from the session that is currently running,
 * never from arguments, so a prompt injection inside a group cannot reach
 * somebody else's card.
 */

import { renderCard } from '../memory/store.js';

/**
 * Register the four memory tools.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {import('../memory/store.js').MemoryStore} options.store Card storage.
 * @param {() => { summaryLimit: number, personaLimit: number }} options.limits Current caps.
 * @param {(sessionId: string) => number | undefined} options.resolveSender Session -> QQ.
 * @param {(line: string) => void} options.log Diagnostic sink.
 * @returns {() => void} Disposer.
 */
export function registerMemoryTools(ctx, options) {
  /**
   * Resolve the card owner for one running tool call.
   *
   * @param {any} exec Tool execution context.
   * @returns {number} The QQ number.
   */
  const ownerOf = exec => {
    const qq = options.resolveSender(String(exec?.agent?.id ?? ''));
    if (qq === undefined) throw new Error('no QQ owner is bound to this session');
    return qq;
  };

  const disposers = [];

  disposers.push(ctx.tools.register({
    name: 'memory_card_get',
    description: 'Read the memory card of the person you are talking to: your stored notes about them and the persona they set. Use it when they ask what you remember, or before answering something personal.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(_args, exec) {
      const qq = ownerOf(exec);
      const card = options.store.get(qq);
      const block = renderCard({ card, name: String(qq), qq });
      return { report: block === '' ? '（这张记忆卡还是空的）' : block, qq, notes: card.notes.length, hasPersona: card.persona !== null };
    },
    presentCall: () => ({ card: 'generic', title: 'Memory card', kind: 'read', rawInput: {} }),
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_note',
    description: 'Append one durable fact to the memory card of the person you are talking to: who they are, what they are building, plans, people, dates — facts you learned from the conversation. Do NOT record behaviour rules here ("别编造", "说简短点", "别用敬语"); those belong in memory_persona_set. Never store passwords, addresses, ID numbers, or other secrets. One fact per call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'One fact, at most a short sentence.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const qq = ownerOf(exec);
      const limit = options.limits().summaryLimit;
      const card = await options.store.addNote(qq, args.text, limit);
      options.log(`memory note for ${qq}: ${String(args.text).slice(0, 40)}`);
      return { report: `已记下。当前 ${card.notes.length} 条。`, notes: card.notes.length };
    },
    presentCall: () => ({ card: 'generic', title: 'Remember', kind: 'other', rawInput: {} }),
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_persona_set',
    description: 'Set or replace the standing instruction this person has given YOU about how to behave with them: tone, length, no flattery, "不要编造/不知道就说不知道", how to address them, what to avoid. Anything that is a rule about YOUR behaviour goes here, never into memory_note. Only they can set it; an empty string clears it. `/记忆卡` renders it back as an image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Style instruction written by the user, or an empty string to clear it.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const qq = ownerOf(exec);
      const limit = options.limits().personaLimit;
      const card = await options.store.setPersona(qq, args.text, limit);
      options.log(`persona updated for ${qq} (${card.persona === null ? 'cleared' : 'set'})`);
      return {
        report: card.persona === null ? '人设已清除。' : `人设已更新：${card.persona.text}`,
        hasPersona: card.persona !== null,
      };
    },
    presentCall: () => ({ card: 'generic', title: 'Persona', kind: 'other', rawInput: {} }),
  }));

  disposers.push(ctx.tools.register({
    name: 'memory_card_clear',
    description: 'Forget everything stored about the person you are talking to: notes and persona. Ask for confirmation first, then call this when they agree.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(_args, exec) {
      const qq = ownerOf(exec);
      await options.store.clear(qq);
      options.log(`memory cleared for ${qq}`);
      return { report: '记忆卡已清空。' };
    },
    presentCall: () => ({ card: 'generic', title: 'Forget me', kind: 'delete', rawInput: {} }),
  }));

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // Disposal is best-effort during teardown.
      }
    }
  };
}

