import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, renderCard } from '../src/memory/store.js';

test('MemoryStore starts empty, notes append, and caps trim the oldest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const store = new MemoryStore(join(dir, 'memory.json'));
    await store.load();
    assert.deepEqual(store.get(10001), { notes: [], persona: null, impressionCursor: 0 });

    await store.addNote(10001, '喜欢简洁的回答');
    await store.addNote(10001, '在做一个 QQ 桥接插件', 30);
    const card = store.get(10001);
    assert.equal(card.notes.length, 2);

    await store.addNote(10001, '住在杭州，喜欢猫', 30);
    const trimmed = store.get(10001);
    assert.ok(trimmed.notes.reduce((sum, note) => sum + note.text.length, 0) <= 30);
    assert.equal(trimmed.notes.at(-1).text, '住在杭州，喜欢猫');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MemoryStore persists, reloads, and clears per owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const file = join(dir, 'memory.json');
    const store = new MemoryStore(file);
    await store.load();
    await store.addNote(20002, '叫我老白');
    await store.setPersona(20002, '说话直接一点');

    const reloaded = new MemoryStore(file);
    await reloaded.load();
    assert.equal(reloaded.get(20002).persona.text, '说话直接一点');
    assert.equal(reloaded.get(20002).notes[0].text, '叫我老白');

    await reloaded.clear(20002);
    assert.deepEqual(reloaded.get(20002), { notes: [], persona: null, impressionCursor: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderCard omits an empty card and labels notes and persona', () => {
  assert.equal(renderCard({ card: { notes: [], persona: null }, name: '小明', qq: 1 }), '');

  const block = renderCard({
    card: { notes: [{ at: 1, text: '喜欢猫' }], persona: { text: '别用敬语', at: 1 } },
    name: '小明',
    qq: 10001,
  });
  assert.match(block, /【记忆卡 · 小明\(10001\)】/);
  assert.match(block, /人设（对方对我的要求，照着做）：别用敬语/);
  assert.match(block, /我对这个人的印象（从聊天里记下的）：/);
  assert.match(block, /- 喜欢猫/);
  assert.match(block, /memory_note/);
});

test('a note is trimmed to one short line and blank notes are ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-to-qq-'));
  try {
    const store = new MemoryStore(join(dir, 'memory.json'));
    await store.load();
    await store.addNote(1, '   ');
    assert.equal(store.get(1).notes.length, 0);

    await store.addNote(1, 'x'.repeat(500));
    assert.equal(store.get(1).notes[0].text.length, 240);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


