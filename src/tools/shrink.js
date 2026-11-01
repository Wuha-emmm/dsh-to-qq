/**
 * `shrink_image`: make a screenshot cheaper to look at.
 *
 * The model reads images with `read_image`, which bills by pixels; a 2560×1440
 * desktop capture is roughly four times the cost of a 1280-wide one. This tool
 * enlarges nothing and keeps the original untouched.
 */

import { shrinkFile, DEFAULT_MAX_EDGE } from '../media/shrink.js';

/**
 * Register the shrink tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {{ log?: (line: string) => void }} [options] Wiring.
 * @returns {() => void} Disposer.
 */
export function registerShrinkTool(ctx, options = {}) {
  const log = options.log ?? (() => {});
  return ctx.tools.register({
    name: 'shrink_image',
    description: 'Shrink a screenshot before reading it: read_image bills by pixels, so a 2560-wide capture costs about four times a 1280-wide one. Returns the path of the smaller copy — call read_image on THAT path. The original file is never modified; if small text becomes unreadable, read the original instead.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute path of the image to shrink.' },
        max_edge: { type: 'number', description: 'Longest edge to keep; default 1280.' },
      },
      required: ['path'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args = {}) {
      const result = await shrinkFile(String(args.path ?? ''), {
        maxEdge: Number(args.max_edge) || DEFAULT_MAX_EDGE,
        log,
      });
      const kb = Math.round(result.bytes / 1024);
      if (!result.shrunk) {
        return { report: `这张图不需要缩（已经够小或缩不了）：${result.path}（${kb}KB）`, path: result.path, shrunk: false };
      }
      const size = result.width === undefined ? '' : `，${result.width}×${result.height}`;
      return {
        report: `已缩成 ${result.path}（${kb}KB${size}）。用 read_image 读这个路径；小字看不清再读原图。`,
        path: result.path,
        shrunk: true,
        bytes: result.bytes,
      };
    },
    presentCall: () => ({ card: 'generic', title: 'Shrink image', kind: 'read', rawInput: {} }),
  });
}
