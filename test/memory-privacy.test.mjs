import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeNote, filterNotes, isSensitiveNote, compileWords } from '../src/memory/sensitive.js';
import { renderCard } from '../src/memory/store.js';

test('remote-control, sign-in and capture notes are dropped', () => {
  const dropped = [
    '用 /yes 远程让电脑开 WeGame、登录账号、进游戏并截图',
    '用语音远程控电脑：截图、发文件、开 WeGame 登录',
    '帮他登录游戏账号',
    '密码是 123456',
    'API key 放在环境变量',
    '手机号 13800138000',
  ];
  for (const text of dropped) assert.equal(isSensitiveNote(text), true, text);
});

test('ordinary project notes survive', () => {
  const kept = [
    '做 dsh-to-qq 插件，坚持插件化',
    '常让 DSH 发记忆卡、群日报，并核对条数',
    '按价格表算会话花销',
  ];
  for (const text of kept) assert.equal(isSensitiveNote(text), false, text);
});

test('a bare local path is softened instead of dropped', () => {
  const result = sanitizeNote('建议数据单独分盘存（D:\\data\\qq）');
  assert.equal(result.dropped, false);
  assert.equal(result.text, '建议数据单独分盘存（本地路径）');
});

test('the owner can add extra sensitive words', () => {
  assert.equal(isSensitiveNote('他说了句私房话', compileWords(['私房话'])), true);
  assert.equal(isSensitiveNote('他说了句私房话'), false);
});

test('filterNotes reports what it removed', () => {
  const result = filterNotes([
    { at: 1, text: '截图给他' },
    { at: 2, text: '喜欢研究模型价钱' },
    { at: 3, text: '路径 E:\\work' },
  ]);
  assert.equal(result.dropped, 1);
  assert.equal(result.softened, 1);
  assert.deepEqual(result.notes.map(note => note.text), ['喜欢研究模型价钱', '路径 本地路径']);
});

test('the prompt card never renders a sensitive note', () => {
  const card = { notes: [{ at: 1, text: '远程登录 WeGame 截图' }, { at: 2, text: '喜欢研究模型价钱' }], persona: null, name: '' };
  const text = renderCard({ card, name: '', qq: 1 });
  assert.equal(text.includes('WeGame'), false);
  assert.match(text, /喜欢研究模型价钱/);
});
