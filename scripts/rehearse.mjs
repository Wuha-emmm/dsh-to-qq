#!/usr/bin/env node
/**
 * End-to-end rehearsal.
 *
 * Runs the pipeline the way a real message would, without QQ: decode an event,
 * resolve the tier, build the prompt, render both cards through the real
 * PowerShell renderer, and exercise the archive plus impression helpers.
 *
 * Usage: node scripts/rehearse.mjs
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeEvent } from '../src/bridge/events.js';
import { tierOf, admit } from '../src/policy/tiers.js';
import { renderContext, SceneBuffer } from '../src/context/buffer.js';
import { renderMemoryCard, renderDigestCard } from '../src/render/memory-card.js';
import { summarizeDigest, formatDigest } from '../src/digest/daily.js';
import { parseImpressionBullets, enoughSignal } from '../src/memory/impressions.js';
import { panelAccess } from '../src/web/guard.js';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

const config = {
  access: {
    admins: [{ qq: 10001 }],
    groups: [20001],
    groupMode: 'whitelist',
    mentionOnly: true,
    strangerPolicy: 'ignore',
    blockedWords: [],
  },
};

// 1. Decode an admin DM and a guest group mention.
const dm = normalizeEvent({
  post_type: 'message',
  message_type: 'private',
  self_id: 10002,
  user_id: 10001,
  message_id: 4242,
  time: 1793393705,
  sender: { nickname: '小明' },
  message: [{ type: 'text', data: { text: '看看今天的群' } }],
});
const group = normalizeEvent({
  post_type: 'message',
  message_type: 'group',
  self_id: 10002,
  group_id: 20001,
  user_id: 999999,
  message_id: 4243,
  time: 1793393800,
  sender: { nickname: '路人', card: '路人甲' },
  message: [
    { type: 'at', data: { qq: '10002' } },
    { type: 'text', data: { text: ' 这条语音说了什么' } },
    { type: 'record', data: { file: 'x.amr' } },
  ],
});
check('admin DM decodes', dm !== undefined && dm.scene === 'dm:10001', dm?.scene);
check('group mention decodes', group !== undefined && group.mentionsBot === true);
check('group sender prefers the card name', group?.senderName === '路人甲', group?.senderName);

// 2. Tier resolution stays inside the documented model.
const dmTier = tierOf(dm, config.access);
const groupTier = tierOf(group, config.access);
check('admin DM is owner', dmTier === 'owner', dmTier);
check('group member is member-group', groupTier === 'member-group', groupTier);

// 3. Prompt rendering from a scene buffer, with a quoted message.
const buffer = new SceneBuffer(20);
buffer.push(group.scene, { senderName: '甲', senderId: 1, text: '先说一句', time: 1793393700, messageId: 1 });
buffer.push(group.scene, { senderName: '乙', senderId: 2, text: '接一句', time: 1793393701, messageId: 2 });
const block = renderContext({
  entries: buffer.recent(group.scene, 10),
  quoted: '甲: 先说一句',
  maxChars: 2000,
});
check('context block renders history and quote', block.includes('先说一句') && block.includes('接一句') && block.includes('引用'));
const capped = renderContext({
  entries: Array.from({ length: 200 }, (_, index) => ({ senderName: 'x', senderId: 1, text: 'a'.repeat(80), time: index })),
  maxChars: 500,
});
check('context respects the character budget', capped.length <= 700, `${capped.length} chars`);

// 4. Digest math on synthetic rows.
const rows = Array.from({ length: 30 }, (_, index) => ({
  sender_id: 100 + (index % 3),
  sender_name: `成员${index % 3}`,
  text: '第'.repeat(10) + index,
  time_unix: 1793389200 + index * 60,
  time_bj: '',
}));
const summary = summarizeDigest(rows);
const digestText = formatDigest(summary, '群 20001', '10/31');
check('digest counts every message', summary.total === 30, String(summary.total));
check('digest names three speakers', summary.senders === 3, String(summary.senders));
check('digest text is non-empty', digestText.length > 40);

// 5. Impression helpers.
const batch = Array.from({ length: 30 }, (_, index) => ({ text: `第${index}句话说得挺长的一共二十来个字` }));
check('impression gate accepts real speech', enoughSignal(batch, 300, 8) === true);
check('impression parser reads bullets', parseImpressionBullets('- 在做桥接\n- 说话简短').length === 2);

// 6. Real card rendering through PowerShell (returns base64:// payloads).
const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-rehearse-'));
try {
  const cardPayload = await renderMemoryCard({
    qq: 10001,
    name: '小明',
    admin: true,
    persona: '回答尽量简短，不用敬语；不知道就说不知道。',
    notes: [
      { at: Date.now(), text: '在写一个把 QQ 接到 DSH 的桥接插件' },
      { at: Date.now(), text: '喜欢先看结论，不要客套' },
    ],
  }, { backdropDir: '' });
  const cardBytes = Buffer.from(cardPayload.replace(/^base64:\/\//, ''), 'base64');
  check('memory card renders to a PNG', cardBytes.length > 5000 && cardBytes[1] === 0x50, `${Math.round(cardBytes.length / 1024)} KB`);

  const digestPayload = await renderDigestCard({
    gid: 20001,
    name: '小鲸鱼们の家',
    dayLabel: '10/31',
    summary,
  }, { backdropDir: '' });
  const digestBytes = Buffer.from(digestPayload.replace(/^base64:\/\//, ''), 'base64');
  check('digest card renders to a PNG', digestBytes.length > 5000 && digestBytes[1] === 0x50, `${Math.round(digestBytes.length / 1024)} KB`);
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

// 7. Panel guard verdicts.
check('loopback panel call allowed', panelAccess({ remoteAddress: '127.0.0.1' }).allowed === true);
check('cross-origin panel call blocked', panelAccess({ remoteAddress: '127.0.0.1', origin: 'https://evil.example', host: '127.0.0.1:1' }).allowed === false);

// 8. Access policy for strangers and groups.
const stranger = normalizeEvent({ post_type: 'message', message_type: 'private', self_id: 10002, user_id: 555, message_id: 9, time: 1793393900, sender: { nickname: '陌生人' }, message: [{ type: 'text', data: { text: 'hi' } }] });
check('stranger DM is refused by admit', admit(stranger, config).accepted === false);
check('group whitelist refuses unknown groups', admit({ ...group, groupId: 1, scene: 'group:1' }, config).accepted === false);

const failed = checks.filter(item => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);




