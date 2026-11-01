/**
 * `bilibili_read`: what a B站 video says, without touching the account.
 *
 * Split out of `bilibili` so a friend or a group can ask "这个视频讲了什么" —
 * captions are public data that merely needs a signed-in cookie, while commenting,
 * posting a dynamic or changing the watch history stay administrator-only.
 */

import { fetchPage, bvidOf } from '../media/page.js';
import { videoIds, videoSubtitles } from '../accounts/bilibili-api.js';

/** Actions this read-only tool offers. */
const ACTIONS = ['subtitle', 'info'];

/**
 * Register the read-only Bilibili tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {import('../accounts/store.js').AccountStore} options.accounts Cookie jar.
 * @param {(line: string) => void} [options.log] Diagnostic sink.
 * @returns {() => void} Disposer.
 */
export function registerBilibiliReadTool(ctx, options) {
  const log = options.log ?? (() => {});
  const cookieFor = url => options.accounts.cookieFor(url);
  const cookie = () => options.accounts.cookieFor('https://www.bilibili.com/');

  return ctx.tools.register({
    name: 'bilibili_read',
    description:
      'Read what a Bilibili video says through its captions (AI captions included) — the cheapest way to know its content, far better than guessing from comments or danmaku. action "subtitle" returns the transcript; action "info" returns title, UP owner, description and comment count. Use it whenever someone shares a B站 link or asks what a video is about.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'subtitle reads the transcript; info reads the metadata.' },
        target: { type: 'string', description: 'Video bvid (BV…) or a Bilibili URL (short links welcome).' },
        max_chars: { type: 'number', description: 'How much transcript text to return; default 3000.' },
      },
      required: ['action', 'target'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args = {}) {
      const action = String(args.action ?? '');
      if (!ACTIONS.includes(action)) throw new Error(`不支持的动作：${action}`);
      const raw = String(args.target ?? '').trim();
      if (raw === '') throw new Error('target 不能为空');
      const bvid = /^BV[0-9A-Za-z]{8,12}$/.test(raw) ? raw : bvidOf(raw === '' ? '' : raw);
      if (bvid === '') {
        // A short link needs resolving before it yields a bvid.
        const page = await fetchPage(raw, { cookieFor });
        if (page.bvid === '') throw new Error('这不是一个 B站 视频链接');
        return action === 'subtitle'
          ? subtitleReport(page.bvid, args, cookie(), cookieFor, log)
          : { report: `${page.title}\n链接：${page.url}` };
      }
      if (action === 'info') {
        const page = await fetchPage(`https://www.bilibili.com/video/${bvid}`, { cookieFor });
        return { report: page.report };
      }
      return subtitleReport(bvid, args, cookie(), cookieFor, log);
    },
    presentCall: () => ({ card: 'generic', title: 'Bilibili read', kind: 'read', rawInput: {} }),
  });
}

/**
 * Build the subtitle report for one video.
 *
 * @param {string} bvid Video id.
 * @param {{ max_chars?: number }} args Tool arguments.
 * @param {string} cookie Cookie header.
 * @param {(url: string) => string} cookieFor Cookie lookup.
 * @param {(line: string) => void} log Diagnostic sink.
 * @returns {Promise<{ report: string, chars: number, lines: number }>} Report.
 */
async function subtitleReport(bvid, args, cookie, cookieFor, log) {
  const ids = await videoIds({ bvid, cookie });
  if (ids === undefined) throw new Error('拿不到这个视频的 aid/cid');
  const subs = await videoSubtitles({ aid: ids.aid, cid: ids.cid, bvid, cookie });
  if (subs === undefined) {
    return { report: `《${ids.title || bvid}》没有字幕（人工和 AI 都没有），这条路走不通`, chars: 0, lines: 0 };
  }
  const limit = Math.max(200, Number(args.max_chars) || 3000);
  const body = subs.text.length > limit ? `${subs.text.slice(0, limit)}…（共 ${subs.chars} 字，已截断）` : subs.text;
  log(`bilibili_read subtitle ${bvid}: ${subs.lines.length} lines, ${subs.chars} chars`);
  return {
    report: [
      `《${ids.title || bvid}》${subs.lanDoc || subs.lan}字幕，${subs.lines.length} 句 / ${subs.chars} 字`,
      subs.lan.startsWith('ai') ? '（AI 字幕，可能有错字）' : '',
      '',
      body,
    ].filter(line => line !== '').join('\n'),
    chars: subs.chars,
    lines: subs.lines.length,
  };
}
