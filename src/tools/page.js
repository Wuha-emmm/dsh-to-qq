/**
 * `fetch_page`: read a page with browser headers and short-link resolution.
 *
 * DSH ships its own `web_fetch`, but Bilibili and several other sites answer a
 * bare request with a block page, and short links (`b23.tv/…`) only redirect to a
 * home page. This tool resolves the redirect and, for Bilibili, reads the public
 * video API so the model can actually answer questions about the link.
 */

import { fetchPage } from '../media/page.js';

/**
 * Register the page fetch tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {{ log?: (line: string) => void }} [options] Wiring.
 * @returns {() => void} Disposer.
 */
export function registerPageTool(ctx, options = {}) {
  const log = options.log ?? (() => {});
  return ctx.tools.register({
    name: 'fetch_page',
    description:
      'Read a web page or link the way a browser does: resolves short links (b23.tv, t.cn, youtu.be, v.douyin.com, xhslink.com) and sends browser headers so Bilibili and similar anti-bot sites answer instead of blocking. Use it when web_fetch fails, or when the person shares a Bilibili video, a short link, or a news card. Localhost and private network addresses are refused.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Page URL, including short links.' },
        max_chars: { type: 'number', description: 'How much page text to keep; default 4000.' },
      },
      required: ['url'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args = {}) {
      const url = String(args.url ?? '').trim();
      if (url === '') throw new Error('url is required');
      const page = await fetchPage(url, { maxChars: Number(args.max_chars) || 4000 });
      log(`fetched ${page.url}`);
      return { report: page.report, url: page.url, title: page.title };
    },
    presentCall: () => ({ card: 'generic', title: 'Fetch page', kind: 'read', rawInput: {} }),
  });
}
