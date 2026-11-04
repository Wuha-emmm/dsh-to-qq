/**
 * Tool: rebase the absolute paths in the bridge config.
 *
 * Used after restoring a backup on another machine, where every saved path still
 * names the old drive. It only touches the three path settings, and a dry run
 * shows the result first.
 */

import { PATH_KEYS, rebasePaths, readPath, writePath } from '../config/rebase.js';

/**
 * Register the tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {object} options.bridge The bridge.
 * @param {object} options.store Config store.
 * @param {(line: string) => void} options.log Diagnostic sink.
 * @returns {() => void} Disposer.
 */
export function registerQqPathsTool(ctx, options) {
  return ctx.tools.register({
    name: 'qq_paths',
    description:
      'List or rewrite the absolute paths in the bridge config. Use it after restoring a backup on another computer: every saved path still names the old drive. Pass from/to to replace a prefix, or neither to just list them. Administrator only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: 'Old prefix to replace, e.g. "E:\\\\". Omit to only list paths.' },
        to: { type: 'string', description: 'New prefix, e.g. "F:\\\\".' },
        dryRun: { type: 'boolean', description: 'Show what would change without saving.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args = {}, exec) {
      const bridge = options.bridge;
      const sessionId = String(exec?.agent?.id ?? '');
      const context = bridge.sessionContext(sessionId);
      if (context === undefined) throw new Error('this session is not bound to a QQ conversation');
      if (context.tier !== 'owner') throw new Error('only the administrator can change paths');

      const config = options.store.get();
      const listing = PATH_KEYS.map(key => `${key} = ${readPath(config, key) || '(empty)'}`);

      const from = typeof args.from === 'string' ? args.from.trim() : '';
      if (from === '') {
        return { report: ['path settings:', ...listing].join('\n'), changed: [] };
      }
      const to = typeof args.to === 'string' ? args.to.trim() : '';
      if (to === '') throw new Error('"to" is required when "from" is given');

      const result = rebasePaths(config, from, to);
      const lines = [`rebasing ${from} -> ${to}`, ...listing];
      for (const item of result.changes) lines.push(`  ${item.key}: ${item.before} -> ${item.after}`);
      if (result.unresolved.length > 0) {
        lines.push('left alone (does not start with the old prefix):');
        for (const item of result.unresolved) lines.push(`  ${item.key} = ${item.value}`);
      }

      if (args.dryRun === true || result.changes.length === 0) {
        lines.push(args.dryRun === true ? 'dry run: nothing saved' : 'nothing to change');
        return { report: lines.join('\n'), changed: [] };
      }

      await options.store.update(draft => {
        for (const item of result.changes) writePath(draft, item.key, item.after);
      });
      options.log(`paths rebased ${from} -> ${to} (${result.changes.length} keys)`);
      lines.push('saved');
      return { report: lines.join('\n'), changed: result.changes };
    },
  });
}
