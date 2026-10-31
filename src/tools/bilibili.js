/**
 * `bilibili`: search, open, comment and post a dynamic with the signed-in account.
 *
 * Owner only: every action here writes to the account, so a group member must not
 * be able to trigger it. The cookie comes from the 登录 tab; nothing is stored on
 * the tool side.
 */

import { fetchPage, bvidOf } from '../media/page.js';
import { launchBrowser, openUrl, findBrowser, playInBrowser } from '../accounts/browser.js';
import {
  postComment,
  userName,
  postDynamic,
  reportHistory,
  searchVideos,
} from '../accounts/bilibili-api.js';

/** Actions the tool accepts. */
const ACTIONS = ['search', 'open', 'comment', 'dynamic', 'history', 'watch'];

/**
 * Resolve a video id and numeric aid from a bvid or URL.
 *
 * @param {string} input bvid, BV URL, or short link.
 * @param {{ cookieFor?: (url: string) => string }} [options] Wiring.
 * @returns {Promise<{ bvid: string, aid: number, title: string } | undefined>} Video identity.
 */
async function resolveVideo(input, options) {
  const raw = String(input ?? '').trim();
  const bvid = /^BV[0-9A-Za-z]{8,12}$/.test(raw) ? raw : bvidOf(raw);
  if (bvid === '') return undefined;
  const page = await fetchPage(`https://www.bilibili.com/video/${bvid}`, { cookieFor: options.cookieFor });
  return { bvid: page.bvid === '' ? bvid : page.bvid, aid: Number(page.aid) || 0, title: page.title };
}

/**
 * Register the Bilibili action tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {import('../accounts/store.js').AccountStore} options.accounts Cookie jar.
 * @param {string} options.profileDir Sign-in browser profile.
 * @param {() => number} options.debugPort Debug port getter.
 * @param {() => string} options.browserPath Browser path getter.
 * @param {(line: string) => void} [options.log] Diagnostic sink.
 * @returns {() => void} Disposer.
 */
export function registerBilibiliTool(ctx, options) {
  const log = options.log ?? (() => {});
  const cookieFor = url => options.accounts.cookieFor(url);
  const cookie = () => options.accounts.cookieFor('https://www.bilibili.com/');

  /**
   * Ensure the sign-in browser is up and show a page in it.
   *
   * @param {string} url Page to open.
   * @returns {Promise<boolean>} True when a tab opened.
   */
  const showInBrowser = async url => {
    const port = options.debugPort();
    if (await openUrl(port, url).catch(() => false)) return true;
    const browser = findBrowser(options.browserPath());
    if (browser === '') return false;
    await launchBrowser({ browser, profileDir: options.profileDir, url, port });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (await openUrl(port, url).catch(() => false)) return true;
    }
    return false;
  };

  return ctx.tools.register({
    name: 'bilibili',
    description:
      'Act on Bilibili with the account signed in through the 登录 tab. Actions: "search" a keyword in a real browser tab (so it lands in the account history) and return the top videos; "open" a video/URL in that browser; "comment" on a video; "dynamic" publish a plain-text dynamic; "history" mark a video as watched. For a mention pass mention as the Bilibili uid: a bare @name in the text links to whoever happens to own that nickname, which is usually not the person meant. Writing needs the cookie; risk control may refuse with its own message.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'What to do.' },
        query: { type: 'string', description: 'Search keyword (action search).' },
        target: { type: 'string', description: 'Video bvid/URL or page URL (open/comment/history).' },
        message: { type: 'string', description: 'Comment text, or dynamic text.' },
        mention: { type: 'string', description: 'Bilibili uid (e.g. 10217007) to @ in the comment. A QQ nickname or a bare @text does not notify anyone.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args = {}) {
      const action = String(args.action ?? '');
      const jar = cookie();
      if (jar === '' && action !== 'open' && action !== 'search') {
        throw new Error('还没有登录 B站：设置 →「登录」→ 打开登录窗口，登录后点「读取登录状态」');
      }
      if (action === 'search') {
        const query = String(args.query ?? '').trim();
        if (query === '') throw new Error('query 不能为空');
        const results = await searchVideos(query, jar);
        const searchUrl = `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`;
        const opened = await showInBrowser(searchUrl);
        const lines = [`搜索「${query}」：${results.length} 条结果（已${opened ? '' : '未'}在登录浏览器打开搜索页）`];
        for (const [index, item] of results.entries()) {
          lines.push(`${index + 1}. ${item.title} — ${item.author}，播放 ${item.play}，${item.url}`);
        }
        if (results.length > 0 && opened) {
          // Opening the first result is what records it in the browser history;
          // the report below asks Bilibili to note it on the account too.
          await showInBrowser(results[0].url).catch(() => false);
          const noted = await reportHistory({ bvid: results[0].bvid, aid: 0, cookie: jar }).catch(() => false);
          lines.push(`已在浏览器打开第一条：${results[0].url}${noted ? '（已上报观看记录）' : ''}`);
        }
        return { report: lines.join('\n'), results };
      }
      if (action === 'open') {
        const url = String(args.target ?? '').trim();
        if (url === '') throw new Error('target 不能为空');
        const opened = await showInBrowser(url);
        return { report: opened ? `已在登录浏览器打开：${url}` : `打不开登录浏览器（检查浏览器路径或端口）：${url}` };
      }
      if (action === 'comment') {
        const video = await resolveVideo(args.target, { cookieFor });
        if (video === undefined) throw new Error('给一个 bvid（BV…）或视频链接');
        if (video.aid <= 0) throw new Error('拿不到这个视频的 aid，B站可能改版了');
        const mentionUid = Number(args.mention) || 0;
        const nickname = mentionUid > 0 ? await userName(mentionUid, jar) : '';
        const result = await postComment({
          aid: video.aid,
          message: String(args.message ?? ''),
          cookie: jar,
          mentionUid,
          ...(nickname === '' ? {} : { mentionNickname: nickname }),
        });
        log(`bilibili comment on ${video.bvid}: ${result.ok ? 'ok' : result.message}`);
        const who = nickname === '' ? '' : `（已 @${nickname}）`;
        return { report: result.ok ? `已评论 ${video.title || video.bvid}${who}：${result.message}` : `评论失败：${result.message}` };
      }
      if (action === 'dynamic') {
        const result = await postDynamic({ text: String(args.message ?? ''), cookie: jar });
        log(`bilibili dynamic: ${result.ok ? 'ok' : result.message}`);
        return { report: result.ok ? result.message : `发动态失败：${result.message}` };
      }
      if (action === 'watch') {
        const raw = String(args.target ?? '').trim();
        const bvid = /^BV[0-9A-Za-z]{8,12}$/.test(raw) ? raw : bvidOf(raw);
        if (bvid === '') throw new Error('给一个 bvid（BV…）或视频链接');
        const port = options.debugPort();
        const url = `https://www.bilibili.com/video/${bvid}`;
        await showInBrowser(url);
        // Wait for the page to boot before asking the player to play.
        let played = 'no-page';
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          played = await playInBrowser(port, bvid, 12);
          if (played === 'played' || played === 'blocked') break;
        }
        const noted = await reportHistory({ bvid, aid: 0, cookie: jar }).catch(() => false);
        log(`bilibili watch ${bvid}: ${played}, reported=${noted}`);
        const text = played === 'played'
          ? `已在登录窗口播放 ${bvid} 约 12 秒${noted ? '，并上报了观看记录' : ''}`
          : played === 'blocked'
            ? '页面加载了但浏览器不允许自动播放（点一下播放键即可）'
            : `没能播放（${played}）`;
        return { report: text };
      }
      if (action === 'history') {
        const video = await resolveVideo(args.target, { cookieFor });
        if (video === undefined || video.aid <= 0) throw new Error('给一个能解析出 aid 的视频');
        const ok = await reportHistory({ aid: video.aid, cookie: jar });
        return { report: ok ? `已把 ${video.bvid} 记为已看` : 'B站没有接受这次历史记录上报（可能需要真实播放）' };
      }
      throw new Error(`不支持的动作：${action}`);
    },
    presentCall: () => ({ card: 'generic', title: 'Bilibili', kind: 'other', rawInput: {} }),
  });
}
