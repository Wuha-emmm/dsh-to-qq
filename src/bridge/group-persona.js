/**
 * Per-group default personas.
 *
 * A group persona belongs to one group, not to one speaker: only an
 * administrator may set it, and it only fills in when the person currently
 * asking has no persona of their own. The personal card stays authoritative,
 * which is what keeps one member from borrowing another member's voice.
 */

/** Shown when the command is used without enough context. */
export const GROUP_PERSONA_USAGE = '用法：在群里发 /群人设 本群默认说话风格；私聊里请带上群号：/群人设 群号 内容。发 /群人设 清空 可以清掉。';

/**
 * Split `/群人设` arguments into the target group and the text.
 *
 * In a group the target is implicit, and a leading copy of the group's own
 * number is accepted so an administrator can paste the same command in either
 * place. In a private chat the first token must be the group number.
 *
 * @param {{ arg: string, kind: 'dm' | 'group', groupId?: number }} input Command context.
 * @returns {{ groupId: number, text: string }} Target group and persona text.
 */
export function resolveGroupPersonaTarget({ arg, kind, groupId }) {
  const body = String(arg ?? '').trim();
  const target = Number(groupId) || 0;
  const match = /^(\d{5,12})(?:\s+([\s\S]*))?$/.exec(body);
  if (kind === 'group') {
    if (match !== null && target > 0 && Number(match[1]) === target) {
      return { groupId: target, text: (match[2] ?? '').trim() };
    }
    return { groupId: target, text: body };
  }
  if (match === null) return { groupId: 0, text: body };
  return { groupId: Number(match[1]), text: (match[2] ?? '').trim() };
}

/**
 * The prompt block sent once per session for a group's default persona.
 *
 * @param {{ text?: string, hasOwnPersona?: boolean, clearedAt?: number }} input Persona state.
 * @returns {string} Prompt block, or '' when it does not apply.
 */
export function renderGroupPersonaBlock({ text, hasOwnPersona, clearedAt = 0 }) {
  // A personal persona overrides the group default; the personal card already
  // tells the model to follow that one.
  if (hasOwnPersona === true) return '';
  const body = String(text ?? '').trim();
  if (body !== '') {
    return [
      '【本群默认人设】',
      body,
      '（这是管理员给本群定的默认说话风格。当前提问的人没有单独的人设，所以按这个来；他自己的记忆卡里另有人设时，以他的个人人设为准。上文出现过别的【本群默认人设】时，以这一条为准。）',
    ].join('\n');
  }
  if (Number(clearedAt) > 0) {
    return '【群默认人设】管理员已清除本群的默认人设，上文出现过的群默认人设一律作废，之后按默认风格回答。';
  }
  return '';
}
