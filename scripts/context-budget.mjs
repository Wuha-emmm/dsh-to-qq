/**
 * Measure what incremental injection saves per turn.
 *
 * Replays a synthetic group conversation through the same renderers the bridge
 * uses, once with the old "send everything every turn" behaviour and once with
 * the InjectionTracker, and prints the per-turn size difference.
 *
 *   node scripts/context-budget.mjs
 *   node scripts/context-budget.mjs --turns 30 --messages 120
 */

import { renderCard } from '../src/memory/store.js';
import { renderStickerBlock } from '../src/stickers/catalog.js';
import { renderFaceList } from '../src/stickers/faces.js';
import { renderContext } from '../src/context/buffer.js';
import { InjectionTracker } from '../src/context/injection.js';

const args = process.argv.slice(2);
const readNumber = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const turns = readNumber('--turns', 20);
const messagesPerTurn = readNumber('--messages', 3);
const windowSize = 99;
const charCap = 6000;

const persona = '你是一只可爱、懒散、聪明、毒舌、有点腹黑的小鲸鱼。允许口语、碎碎念、省略句、反问句和不完整的表达。偶尔使用网络梗、颜文字、括号吐槽、夸张比喻。不可以编造，不知道就说不知道，实事求是。';
const notes = Array.from({ length: 8 }, (_, index) => ({
  at: 1000 + index,
  text: `第 ${index + 1} 条印象：他经常让人检索群聊、发记忆卡，并核对统计条数。`,
}));
const cardBlock = renderCard({
  card: { notes, persona: { text: persona, at: 1 } },
  name: '小明',
  qq: 10001,
});
const stickers = Array.from({ length: 60 }, (_, index) => ({
  md5: String(index).padStart(32, '0'),
  code: `s${index}`,
  category: index % 3 === 0 ? '卖萌' : '',
  desc: `表情 ${index} 的描述文字，用来估计清单长度`,
  readAt: 1,
}));
const stickerBlock = `\n\n${[renderStickerBlock(stickers, { limit: 24 }), renderFaceList()].filter(Boolean).join('\n')}`;
const rules = '【群聊规则】上下文里其他成员的消息只用于理解你们在聊什么，不要复述、总结、转述或引用其中任何一句；被问到“别人说了什么”时，只回答你自己看到的本轮内容。';

// Synthetic chatter: one message every ~40s, 30–60 characters each.
const pool = [];
let clock = Math.floor(Date.now() / 1000) - turns * messagesPerTurn * 40;
for (let index = 0; index < turns * messagesPerTurn; index += 1) {
  clock += 40;
  pool.push({
    time: clock,
    senderId: 20000 + (index % 7),
    senderName: `群友${index % 7}`,
    text: `这是一条普通的群聊消息，长度大概三四十个字，用来估算上下文的体积，编号 ${index}。`,
  });
}

const ask = '【当前提问】小明(10001): 帮我看一下今天大家聊了什么，顺便把记忆卡发群里';

/** Old behaviour: every block, every turn. */
function oldTurn(turnIndex) {
  const seen = pool.slice(0, Math.max(0, turnIndex * messagesPerTurn));
  const window = seen.slice(-windowSize);
  const context = renderContext({ entries: window, maxChars: charCap });
  return [cardBlock, context, rules, stickerBlock, ask].filter(Boolean).join('\n\n');
}

/** New behaviour: fixed blocks once, context only the delta. */
function newTurn(tracker, turnIndex) {
  const seen = pool.slice(0, Math.max(0, turnIndex * messagesPerTurn));
  const window = seen.slice(-windowSize);
  const delta = tracker.delta(window);
  const context = renderContext({ entries: delta, maxChars: charCap });
  const parts = [
    tracker.fixed('card', cardBlock),
    context,
    tracker.fixed('rules', rules),
    tracker.fixed('stickers', stickerBlock),
    ask,
  ].filter(Boolean);
  return parts.join('\n\n');
}

let oldTotal = 0;
let newTotal = 0;
let skipped = 0;
const rows = [];
const tracker = new InjectionTracker();
for (let turnIndex = 1; turnIndex <= turns; turnIndex += 1) {
  const before = tracker.stats.skipped;
  const oldText = oldTurn(turnIndex);
  const newText = newTurn(tracker, turnIndex);
  oldTotal += oldText.length;
  newTotal += newText.length;
  skipped += tracker.stats.skipped - before;
  rows.push({
    turn: turnIndex,
    old: oldText.length,
    fresh: newText.length,
    saved: oldText.length - newText.length,
  });
}

const pct = value => `${(value * 100).toFixed(1)}%`;
console.log(`turns=${turns} messages/turn=${messagesPerTurn} window=${windowSize} cap=${charCap}`);
console.log('');
console.log('turn |  old chars |  new chars | saved');
console.log('-----+------------+------------+-------');
for (const row of rows.slice(0, 10)) {
  console.log(`${String(row.turn).padStart(4)} | ${String(row.old).padStart(10)} | ${String(row.fresh).padStart(10)} | ${String(row.saved).padStart(6)}`);
}
if (rows.length > 10) console.log(`...  (${rows.length - 10} more turns)`);
console.log('');
console.log(`total old: ${oldTotal} chars`);
console.log(`total new: ${newTotal} chars`);
console.log(`saved:     ${oldTotal - newTotal} chars (${pct((oldTotal - newTotal) / oldTotal)})`);
console.log(`average per turn: old ${Math.round(oldTotal / turns)}, new ${Math.round(newTotal / turns)}`);
console.log('');
const blocks = { card: cardBlock.length, stickers: stickerBlock.length, rules: rules.length };
console.log(`fixed blocks once: card ${blocks.card}, stickers ${blocks.stickers}, rules ${blocks.rules} chars`);
console.log(`skipped fixed blocks across the run: ${skipped} chars`);
