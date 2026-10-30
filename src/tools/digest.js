/**
 * `group_digest`: answer "今天群里聊了啥" with the same card as `/日报`.
 */

import { summarizeDigest, startOfBeijingDay, DIGEST_ROW_LIMIT } from '../digest/daily.js';
import { renderDigestCard } from '../render/memory-card.js';

/**
 * Register the tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {object} options.bridge Bridge (client, archive, media dir).
 * @param {(line: string) => void} options.log Diagnostic sink.
 * @returns {() => void} Disposer.
 */
export function registerDigestTool(ctx, options) {
  return ctx.tools.register({
    name: 'group_digest',
    description: 'Render today\'s digest of this group — message count, busiest hour, and the top talkers — as an image and send it here. Use it when someone asks what the group talked about today, 今天的日报, or 群里今天热闹吗. The image is the answer: do not announce the send in your reply, and stay silent after a successful call unless something failed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        group_id: { type: 'number', description: 'Optional group id; administrators only. Defaults to the current group.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args = {}, exec) {
      const bridge = options.bridge;
      const info = bridge.sessionContext(String(exec?.agent?.id ?? ''));
      if (info === undefined) throw new Error('this session is not bound to a QQ conversation');
      if (bridge.client === undefined) throw new Error('the QQ transport is not connected');
      const requested = Number(args.group_id);
      const gid = Number.isInteger(requested) && requested > 0
        ? requested
        : Number(info.scene.slice(info.scene.indexOf(':') + 1));
      if (!Number.isInteger(gid) || gid <= 0) throw new Error('this conversation is not a group');

      const since = Math.floor(startOfBeijingDay() / 1000);
      const rows = bridge.archive?.search({ scene: `group:${gid}`, since, limit: DIGEST_ROW_LIMIT }) ?? [];
      const summary = summarizeDigest(rows);

      let name = '';
      try {
        const groupInfo = await bridge.client.call('get_group_info', { group_id: gid }, { timeoutMs: 5000 });
        name = groupInfo?.group_name ?? groupInfo?.data?.group_name ?? '';
      } catch {
        name = '';
      }
      const dayLabel = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
      const payload = await renderDigestCard({ gid, name, dayLabel, summary }, {
        log: options.log,
        backdropDir: bridge.mediaDir,
      });
      await bridge.client.call(
        'send_group_msg',
        { group_id: gid, message: [{ type: 'image', data: { file: payload } }] },
        { timeoutMs: 30_000 },
      );
      options.log(`digest card sent to group ${gid}`);
      bridge.noteCardSent?.();
      bridge.recordSceneOutbound?.(`group:${gid}`, `[图片] 群日报 ${summary.total} 条消息`, 'image');
      return { report: `已把今天的群日报发到群里（${summary.total} 条消息）。`, total: summary.total };
    },
    presentCall: () => ({ card: 'generic', title: 'Group digest', kind: 'other', rawInput: {} }),
  });
}




