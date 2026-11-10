#!/usr/bin/env node
/**
 * Generate `docs/configuration.md` from the real defaults.
 *
 * The reference used to be maintained by hand and drifted. Generating it from
 * `src/config/defaults.js` keeps defaults, ranges and types truthful; only the
 * prose lives here.
 *
 * Usage: node scripts/docs-config.mjs [--check]
 *   --check  exit non-zero when the committed file is stale
 */

import { readFile, writeFile } from 'node:fs/promises';
import { defaults, RANGES } from '../src/config/defaults.js';

/** One-line explanations, keyed by config path. */
const HINTS = {
  'connection.enabled': '总开关；关闭后桥不连接 OneBot、不处理任何消息',
  'connection.httpUrl': 'OneBot HTTP 地址，用于发消息、查状态、取语音',
  'connection.wsUrl': 'OneBot 事件推送地址',
  'connection.eventPath': '事件路径，SnowLuma 为 `/`',
  'connection.snowlumaWebui': 'SnowLuma 控制台地址，设置页的「打开控制台」用它',
  'connection.reconnect.enabled': '断线后自动重连',
  'connection.reconnect.baseMs': '首轮重连等待',
  'connection.reconnect.maxMs': '重连等待上限（指数退避）',
  'models.owner.model': '管理员私聊模型；空 = 该服务商首个模型',
  'models.owner.effort': '管理员私聊的推理级别；空 = 默认',
  'models.member.model': '访客与群成员模型',
  'models.member.effort': '访客与群成员的推理级别',
  'models.summarizer.model': '翻译与印象整理的模型',
  'models.summarizer.effort': '翻译与印象整理的推理级别',
  'connection.snowlumaDir': 'SnowLuma 安装目录；填了才能自动启动',
  'connection.autoStart': 'DSH 启动时顺带拉起 SnowLuma',
  'connection.token': 'OneBot HTTP access token（设置页不显示）',
  'connection.httpToken': '桥面板的额外口令（可留空，面板已限本机同源）',
  'connection.snowlumaWebui': 'SnowLuma 控制台地址，设置页的「打开控制台」用它',
  'access.admins': '管理员 QQ 列表，私聊拥有全权',
  'access.groupMode': '群策略：whitelist / blacklist / all',
  'access.groups': '参与策略的群号列表',
  'access.mentionOnly': '群里必须 @ 机器人才回应',
  'access.strangerPolicy': '陌生人私聊：ignore / notice / block',
  'access.blockedWords': '命中这些词的群消息直接丢弃',
  'models.owner.provider': '管理员私聊使用的服务商；空 = DSH 默认',
  'models.member.provider': '访客与群成员使用的服务商；空 = DSH 默认',
  'models.summarizer.provider': '翻译与印象整理使用的服务商；空 = 自动挑可用项',
  'conversation.groupHistory': '群聊每次注入的历史消息条数',
  'conversation.groupCharCap': '注入群上下文的字数上限',
  'conversation.cwd': '为 QQ 会话指定工作目录；空 = DSH 默认',
  'memory.summaryLimit': '单张记忆卡保留的字数上限',
  'memory.personaLimit': '人设文本长度上限',
  'memory.autoNoteEvery': '每 N 轮提醒模型记一条；0 = 关闭',
  'memory.impressionsEnabled': '后台自动整理印象（不发消息）',
  'memory.impressionEvery': '攒够多少条发言整理一次印象',
  'memory.impressionMinChars': '触发整理前至少需要的有效字数',
  'memory.impressionBudget': '印象列表总字数上限',
  'limits.memberDaily': '每人每天可提问次数（0 = 不限）',
  'limits.groupDaily': '每群每天可回答次数（0 = 不限）',
  'limits.userPerMinute': '每人每分钟最多提问次数',
  'limits.maxInputChars': '单条消息超过此长度会被截断',
  'limits.concurrency': '同时进行的回答数',
  'limits.queueMax': '排队上限，超过直接拒绝',
  'limits.turnTimeoutMs': '单轮回答超时，超时后释放并发槽',
  'limits.replyDelayMs': '回答前的基础延迟',
  'limits.jitterMs': '在基础延迟上叠加的随机抖动',
  'limits.maxDelayMs': '延迟上限',
  'limits.overLimit': '超限行为：refuse / silent / queue',
  'output.imageThreshold': '回答超过该字数就转成图片',
  'output.style': '图片风格：light / dark / bubble',
  'output.fontSize': '转图字号',
  'output.width': '转图宽度（像素）',
  'output.sendProcessingHint': '回答前先发一句「收到，正在处理」',
  'output.sendTypingStatus': '显示 QQ「正在输入」状态',
  'output.groupAtReply': '群聊回复开头 @ 提问的人，避免多人同时问时分不清对象',
  'stickers.enabled': '向模型提供表情包库并允许发送',
  'stickers.inPrompt': '每次提示里列出多少张表情',
  'stickers.perHourPerScene': '同一个会话每小时最多发几张',
  'stickers.describeBatch': '每次同步最多识别多少张新表情',
  'voice.enabled': '收到语音时是否转文字',
  'voice.language': '识别语言，如 zh / en',
  'voice.command': '本地识别命令模板（{input} {language}）；留空不用',
  'voice.qqAsr': '是否使用 QQ 原生语音转文字（默认开）',
  'archive.enabled': '是否记录聊天档案',
  'archive.media': '把收到的图片存到本地 media/',
  'archive.retentionDays': '档案与媒体的保留天数（0 = 永久）',
  'digest.enabled': '每天定时把群日报图发到群',
  'digest.hour': '日报时间（北京时间，0-23）',
  'digest.minute': '日报时间（分，0-59）',
  'digest.groups': '要发日报的群；空 = 跟随 access.groups',
  'safety.confirmWrite': '危险工具需要 QQ 里 `/yes` 确认',
  'safety.confirmTtlMs': '确认的有效期',
  'safety.proactive': '允许主动推送',
  'safety.audit': '记录审计事件',
  'ui.overlayPosition': '悬浮窗默认位置',
};

/**
 * Read one value out of the default config.
 *
 * @param {any} config Default config object.
 * @param {string} path Dotted path.
 * @returns {any} The value, or undefined.
 */
function valueAt(config, path) {
  return path.split('.').reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), config);
}

/**
 * Render one value for a markdown cell.
 *
 * @param {any} value Raw value.
 * @returns {string} Display text.
 */
function show(value) {
  if (value === undefined) return '—';
  if (Array.isArray(value)) return value.length === 0 ? '`[]`' : `\`${JSON.stringify(value)}\``;
  if (value === '') return '`""`（空）';
  if (typeof value === 'string') return `\`${value}\``;
  return `\`${String(value)}\``;
}

/**
 * Walk the default config and collect one row per leaf plus its section.
 *
 * @param {any} node Current node.
 * @param {string[]} path Path so far.
 * @param {Array<{ section: string, path: string, value: any, range?: number[] }>} rows Output.
 * @returns {void}
 */
function walk(node, path, rows) {
  for (const [key, value] of Object.entries(node)) {
    const next = [...path, key];
    const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
    if (isObject) {
      walk(value, next, rows);
      continue;
    }
    const dotted = next.join('.');
    rows.push({ section: next[0], path: dotted, value, range: RANGES[dotted] });
  }
}

const rows = [];
walk(defaults(), [], rows);

const sections = [];
for (const row of rows) {
  if (!sections.includes(row.section)) sections.push(row.section);
}

const lines = [
  '# 配置参考',
  '',
  '> 由 `npm run docs` 从 `src/config/defaults.js` 生成，改代码后重新生成即可；不要手改本文件。',
  '',
  '配置文件位置：`~/.dsh/dsh-to-qq/config.json`（Windows：`C:\\Users\\<你>\\.dsh\\dsh-to-qq\\config.json`）。',
  '设置页修改的是同一份文件；`token` / `httpToken` 不会回显。',
  '',
  '未知键会被丢弃，越界的数字会被夹到范围内。',
  '',
];

for (const section of sections) {
  const sectionRows = rows.filter(row => row.section === section);
  lines.push(`## ${section}`, '', '| 键 | 默认值 | 范围 | 说明 |', '|---|---|---|---|');
  for (const row of sectionRows) {
    const short = row.path.slice(section.length + 1);
    const range = row.range === undefined ? '—' : `\`${row.range[0]} ~ ${row.range[1]}\``;
    lines.push(`| \`${short}\` | ${show(row.value)} | ${range} | ${HINTS[row.path] ?? ''} |`);
  }
  lines.push('');
}

const output = `${lines.join('\n').trimEnd()}\n`;
const target = new URL('../docs/configuration.md', import.meta.url);
const check = process.argv.includes('--check');

if (check) {
  let current = '';
  try {
    current = await readFile(target, 'utf8');
  } catch {
    current = '';
  }
  if (current !== output) {
    console.error('docs/configuration.md is stale; run: node scripts/docs-config.mjs');
    process.exit(1);
  }
  console.log('docs/configuration.md is up to date');
} else {
  await writeFile(target, output, 'utf8');
  console.log(`wrote docs/configuration.md (${rows.length} keys, ${sections.length} sections)`);
}


