/**
 * Slash commands the administrator can send over QQ.
 *
 * They run before the model: a command must never reach an agent, and a paused
 * bridge must still answer `/继续`.
 */

/** Recognized command names, Chinese and English. */
const ALIASES = new Map([
  ['暂停', 'pause'],
  ['pause', 'pause'],
  ['继续', 'resume'],
  ['resume', 'resume'],
  ['列表', 'list'],
  ['list', 'list'],
  ['切换', 'switch'],
  ['switch', 'switch'],
  ['新建', 'new'],
  ['new', 'new'],
  ['状态', 'status'],
  ['status', 'status'],
  ['记忆卡', 'card'],
  ['卡片', 'card'],
  ['card', 'card'],
  ['日报', 'digest'],
  ['digest', 'digest'],
  ['人设', 'persona'],
  ['persona', 'persona'],
  ['补印象', 'impressions'],
  ['impressions', 'impressions'],
]);

/**
 * Parse one message as a command.
 *
 * @param {string} text The message body.
 * @returns {{ name: string, arg: string } | undefined} The command, or undefined.
 */
export function parseCommand(text) {
  const match = /^\s*\/([a-zA-Z\u4e00-\u9fa5]+)\s*(.*)$/s.exec(String(text ?? ''));
  if (match === null) return undefined;
  const name = ALIASES.get(match[1].toLowerCase());
  if (name === undefined) return undefined;
  return { name, arg: match[2].trim() };
}

/**
 * Format the session list with stable indices for `/切换`.
 *
 * @param {ReadonlyArray<{ id: string, title?: string, updatedAt?: number }>} items Sessions.
 * @param {number} [limit] How many to show.
 * @returns {string} Message body.
 */
export function formatSessionList(items, limit = 10) {
  if (items.length === 0) return '没有可切换的会话。';
  const lines = [`最近的会话（最多 ${limit} 个）：`];
  for (const [index, item] of items.slice(0, limit).entries()) {
    const title = typeof item.title === 'string' && item.title !== '' ? item.title : '（无标题）';
    lines.push(`${index + 1}. ${title}`);
  }
  lines.push('回 /切换 序号 切过去，/新建 开一个新的。');
  return lines.join('\n');
}

/**
 * Pull session rows out of whatever shape the controller returned.
 *
 * @param {any} value Result of `sessionController.list(...)`.
 * @returns {Array<{ id: string, title?: string, updatedAt?: number }>} Sessions.
 */
export function extractSessions(value) {
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(value?.items) ? value.items
      : Array.isArray(value?.sessions) ? value.sessions
        : Array.isArray(value?.value?.items) ? value.value.items
          : [];
  return raw
    .map(item => (item !== null && typeof item === 'object' ? { ...item } : null))
    .filter(item => item !== null && typeof item.id === 'string')
    .map(item => ({ id: item.id, title: item.title ?? item.summary, updatedAt: item.updatedAt }));
}


