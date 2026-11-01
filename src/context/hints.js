/**
 * Behaviour hints injected into a QQ turn, filtered by what that tier can do.
 *
 * These used to be one 411-character block for every session, which told a friend
 * DM to use `group_digest` and `bilibili` — tools that tier does not have. A hint
 * now names the tools it is about, and is only sent when all of them are available.
 *
 * Data (memory card, group window, sticker list) is not a hint and stays injected
 * separately; this module is only about instructions.
 */

/** Rules that apply to every tier. */
export const HINTS = [
  {
    id: 'length',
    tiers: '*',
    tools: [],
    text: context => `【回复长度】尽量控制在 ${context.lengthLimit} 字以内；内容较长时正常输出，我会自动转成图片发出去。`,
  },
  {
    id: 'bilibili',
    tiers: '*',
    tools: ['bilibili_read'],
    text: () => '【B站视频】要知道某个 B站视频讲了什么，用 bilibili_read 工具的 subtitle 动作读字幕（登录态已就绪）；没有字幕再想别的办法，别先下结论说看不到。',
  },
  {
    id: 'digest',
    tiers: ['owner', 'owner-group', 'member-group'],
    tools: ['group_digest'],
    text: () => '【日报】要出日报就直接调 group_digest（day 传 today / yesterday / 前天 / YYYY-MM-DD），它两秒出图；不要用 qq_history 自己翻记录统计，那样要好几分钟。',
  },
  {
    id: 'send',
    tiers: '*',
    tools: ['qq_send'],
    text: () => '【发图发文件只用 qq_send】不要用 pwsh 调 OneBot/SnowLuma 的发送接口；qq_send 在界面发起的回合里也能用（会自动找回 QQ 场景）。',
  },
  {
    id: 'shrink',
    tiers: ['owner'],
    tools: ['shrink_image'],
    text: () => '【看图先缩图】读截图前先调 shrink_image 拿小图路径，再用 read_image 读它；read_image 按像素计费，2560 宽的截图是 1280 宽的四倍。小字看不清再读原图。',
  },
  {
    id: 'no-repeat',
    tiers: '*',
    tools: [],
    text: () => '【别重复】长任务执行中只报一次进度；同一句话不要发第二遍；被授权拦住时只说"需要放行 X"，不要重述整段计划。授权一次默认 15 分钟内有效，够你把这事做完。',
  },
];

/**
 * Build the hint block for one turn.
 *
 * @param {{ tier: string, tools?: ReadonlyArray<string>, lengthLimit?: number }} context What this turn may use.
 * @returns {string} Hint text (empty when nothing applies).
 */
export function buildHints(context) {
  const tier = String(context?.tier ?? '');
  const available = context?.tools === undefined || context.tools === '*'
    ? undefined
    : new Set(context.tools);
  const lengthLimit = Number(context?.lengthLimit) || 0;
  const parts = [];
  for (const hint of HINTS) {
    if (hint.tiers !== '*' && !hint.tiers.includes(tier)) continue;
    if (available !== undefined && hint.tools.some(tool => !available.has(tool))) continue;
    parts.push(hint.text({ lengthLimit }));
  }
  return parts.join('');
}
