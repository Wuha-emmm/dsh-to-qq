import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StickerStore } from '../src/stickers/store.js';
import { renderStickerBlock, findStickers, stickerHandle } from '../src/stickers/catalog.js';
import { describePrompt, parseDescription, DESCRIBE_SYSTEM } from '../src/stickers/describe.js';

const md5 = '1E54425C18581B3777ECD486236FD4C6';
const other = 'D09BCC33AAAAAAAAAAAAAAAAAAAAAAAA';

test('merge keeps hashes, ignores junk, and never erases a description', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-stickers-'));
  try {
    const store = new StickerStore(join(dir, 'stickers.json'));
    await store.load();
    const first = store.merge([
      { emoji_id: `x_${md5}_0_0`, md5: md5.toLowerCase(), url: 'https://a/1', desc: '鲸鱼娘女仆装' },
      { md5: 'not-a-hash' },
    ]);
    assert.deepEqual(first, { added: 1, updated: 0, total: 1 });

    // A later sync with no description must not wipe the learned one.
    const second = store.merge([{ md5, url: 'https://a/2', desc: '' }]);
    assert.equal(second.added, 0);
    assert.equal(store.find(md5).desc, '鲸鱼娘女仆装');
    assert.equal(store.find(md5).url, 'https://a/1', 'missing fields never overwrite');

    await store.save();
    const reloaded = new StickerStore(join(dir, 'stickers.json'));
    await reloaded.load();
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.find(md5.slice(0, 6)).desc, '鲸鱼娘女仆装');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('find accepts full id, md5, and a unique md5 prefix', async () => {
  const store = new StickerStore(join(tmpdir(), 'unused.json'));
  await store.load();
  store.merge([{ emoji_id: 'full-id', md5, url: 'u', desc: 'd' }]);
  assert.equal(store.find('full-id')?.md5, md5.toLowerCase());
  assert.equal(store.find(md5)?.md5, md5.toLowerCase());
  assert.equal(store.find(md5.slice(0, 6))?.md5, md5.toLowerCase());
  assert.equal(store.find('zzz'), undefined);
});

test('unread lists only stickers without a description, oldest first', async () => {
  const store = new StickerStore(join(tmpdir(), 'unused.json'));
  await store.load();
  store.merge([
    { md5, desc: '有描述' },
    { md5: other.toLowerCase(), desc: '' },
  ]);
  const pending = store.unread(5);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].md5, other.toLowerCase());
  assert.equal(store.setDescription(other, '  新描述  '), true);
  assert.equal(store.unread(5).length, 0);
  assert.equal(store.find(other).desc, '新描述');
});

test('the catalog block lists described stickers and hides the rest', () => {
  const block = renderStickerBlock([
    { md5: md5.toLowerCase(), desc: '鲸鱼娘女仆装，适合卖萌' },
    { md5: other.toLowerCase(), desc: '' },
  ]);
  assert.match(block, /1e5442 鲸鱼娘女仆装/);
  assert.equal(block.includes(other.slice(0, 6).toLowerCase()), false);
  assert.match(block, /语境真的合适/);
});

test('an empty catalog renders nothing', () => {
  assert.equal(renderStickerBlock([]), '');
  assert.equal(renderStickerBlock([{ md5, desc: '' }]), '');
});

test('findStickers matches handles first, then descriptions', () => {
  const library = [
    { md5: md5.toLowerCase(), desc: '鲸鱼娘女仆装' },
    { md5: other.toLowerCase(), desc: '无语的猫猫头' },
  ];
  assert.equal(findStickers(library, stickerHandle({ md5: md5.toLowerCase() }))[0].md5, md5.toLowerCase());
  assert.equal(findStickers(library, '猫猫')[0].md5, other.toLowerCase());
  assert.deepEqual(findStickers(library, '没有这个'), []);
});

test('descriptions are cleaned into one short line', () => {
  assert.equal(parseDescription('1. "一只蓝色鲸鱼娘在笑"'), '一只蓝色鲸鱼娘在笑');
  assert.equal(parseDescription('好的\n第二行'), '好的');
  assert.equal(parseDescription('   '), '');
  assert.ok(parseDescription('a'.repeat(80)).length <= 40);
});

test('the describing prompt carries existing fields and asks for structure', () => {
  const prompt = describePrompt({ desc: '已有说明', category: '卖萌' });
  assert.match(prompt, /已有说明/);
  assert.match(prompt, /卖萌/);
  assert.match(prompt, /画面\|情绪\|用途/);
  assert.match(describePrompt({}), /QQ 收藏表情/);
  assert.match(DESCRIBE_SYSTEM, /开心.*卖萌.*无语/);
});

test('manual edits win over later model descriptions', async () => {
  const store = new StickerStore(join(tmpdir(), 'unused.json'));
  await store.load();
  store.merge([{ md5, desc: '' }]);
  const edited = store.update(md5, { code: '7', category: '卖萌', desc: '我写的备注' });
  assert.equal(edited.code, '7');
  assert.equal(edited.category, '卖萌');
  assert.equal(edited.manual, true);
  assert.equal(edited.readAt > 0, true);
  // A later generated description must not overwrite manual text.
  store.setDescription(md5, '模型猜的');
  assert.equal(store.find(md5).desc, '我写的备注');
  assert.equal(store.readCount, 1);
});

test('codes stay unique', async () => {
  const store = new StickerStore(join(tmpdir(), 'unused.json'));
  await store.load();
  store.merge([{ md5 }, { md5: other }]);
  store.update(md5, { code: 'abc' });
  store.update(other, { code: 'abc' });
  assert.equal(store.find(md5).code, 'abc');
  assert.notEqual(store.find(other).code, 'abc', 'second claim is ignored');
});

test('muting is per scene and survives a reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-stickers-'));
  try {
    const file = join(dir, 'stickers.json');
    const store = new StickerStore(file);
    await store.load();
    store.merge([{ md5 }]);
    store.mute('group:1');
    assert.equal(store.isMuted('group:1'), true);
    assert.equal(store.isMuted('group:2'), false);
    await store.save();
    const reloaded = new StickerStore(file);
    await reloaded.load();
    assert.equal(reloaded.isMuted('group:1'), true);
    reloaded.unmute('group:1');
    assert.equal(reloaded.isMuted('group:1'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a muted catalog tells the model not to send', () => {
  const block = renderStickerBlock([{ md5, desc: '鲸鱼娘' }], { muted: true });
  assert.match(block, /不要发/);
  assert.equal(block.includes('鲸鱼娘'), false);
});

test('only read stickers reach the catalog', () => {
  const block = renderStickerBlock([
    { md5, desc: '已读的', readAt: 1, code: 'abc', category: '卖萌' },
    { md5: other, desc: '未读的', readAt: 0, code: 'def' },
  ]);
  assert.match(block, /abc〔卖萌〕 已读的/);
  assert.equal(block.includes('def'), false);
});

test('mute phrases are recognised, and so is lifting them', async () => {
  const { wantsNoStickers, wantsStickers } = await import('../src/stickers/mute.js');
  assert.equal(wantsNoStickers('别发表情包了'), true);
  assert.equal(wantsNoStickers('以后不要用表情了'), true);
  assert.equal(wantsNoStickers('这个表情包不错'), false);
  assert.equal(wantsStickers('可以发表情包'), true);
  assert.equal(wantsStickers('发表情吧'), true);
  assert.equal(wantsStickers('别发表情'), false);
});

test('built-in faces resolve by name, id, and mood', async () => {
  const { findFace, renderFaceList } = await import('../src/stickers/faces.js');
  assert.equal(findFace('狗头').id, 179);
  assert.equal(findFace('14').name, '微笑');
  assert.equal(findFace('无语').id, 22);
  assert.equal(findFace('99999').id, 99999, 'unknown numeric ids still pass through');
  assert.equal(findFace('不存在的脸'), undefined);
  const line = renderFaceList();
  assert.match(line, /狗头179/);
  assert.match(line, /emoji_send/);
});

test('structured analysis becomes desc plus category', async () => {
  const { parseAnalysis, normalizeMood } = await import('../src/stickers/describe.js');
  const one = parseAnalysis('猫猫敲键盘|无语|对方抱怨加班时');
  assert.equal(one.desc, '猫猫敲键盘，对方抱怨加班时');
  assert.equal(one.category, '无语');

  const two = parseAnalysis('狗头（反讽）|嘲讽/开心|开玩笑收尾');
  assert.equal(two.category, '嘲讽', 'first known mood wins');
  assert.match(two.desc, /开玩笑收尾/);

  const plain = parseAnalysis('一只鲸鱼在笑');
  assert.equal(plain.desc, '一只鲸鱼在笑');
  assert.equal(plain.category, '');

  assert.equal(parseAnalysis('   ').desc, '');
  assert.equal(normalizeMood('有点无语'), '无语');
  assert.equal(normalizeMood(''), '');
});

test('analysis feeds desc and category into the store', async () => {
  const store = new StickerStore(join(tmpdir(), 'unused.json'));
  await store.load();
  store.merge([{ md5 }]);
  const { parseAnalysis } = await import('../src/stickers/describe.js');
  store.setDescription(md5, parseAnalysis('鲸鱼娘鼓掌|鼓励|对方完成一件事时'));
  const sticker = store.find(md5);
  assert.equal(sticker.category, '鼓励');
  assert.match(sticker.desc, /鲸鱼娘鼓掌/);
  assert.equal(sticker.readAt > 0, true);
  // A second pass must not wipe an owner category.
  store.update(md5, { category: '卖萌' });
  store.setDescription(md5, parseAnalysis('鲸鱼娘|鼓励|随便'));
  assert.equal(store.find(md5).category, '卖萌');
});

test('an explicit re-analysis may replace a manual edit', async () => {
  const store = new StickerStore(join(tmpdir(), 'unused.json'));
  await store.load();
  store.merge([{ md5, desc: '' }]);
  store.update(md5, { desc: '我写的', category: '卖萌' });
  // Bulk re-analysis must leave the manual text alone.
  store.setDescription(md5, { desc: '模型猜的', category: '无语' });
  assert.equal(store.find(md5).desc, '我写的');
  assert.equal(store.find(md5).manual, true);
  // Single-sticker re-analysis (force) replaces it and hands it back to the model.
  store.setDescription(md5, { desc: '鲸鱼娘敲键盘，对方加班时', category: '无语' }, undefined, { force: true });
  assert.equal(store.find(md5).desc, '鲸鱼娘敲键盘，对方加班时');
  assert.equal(store.find(md5).category, '无语');
  assert.equal(store.find(md5).manual, false);
});
