import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutPersona } from '../src/render/memory-card.js';

const SAMPLE = '你是一只可爱、懒散、聪明、毒舌、有点腹黑的小鲸鱼。允许口语、碎碎念、省略句、反问句和不完整的表达。偶尔使用网络梗、颜文字、括号吐槽、夸张比喻。不可以编造，不知道就说不知道，实事求是。';

test('the lead sentence keeps its own line and the rules become bullets', () => {
  const out = layoutPersona(SAMPLE);
  const lines = out.split('\n');
  assert.equal(lines[0], '你是一只可爱、懒散、聪明、毒舌、有点腹黑的小鲸鱼。');
  assert.equal(lines[1], '', 'a blank line separates the lead from the rules');
  assert.deepEqual(lines.slice(2).map(line => line.slice(2)), [
    '允许口语、碎碎念、省略句、反问句和不完整的表达。',
    '偶尔使用网络梗、颜文字、括号吐槽、夸张比喻。',
    '不可以编造，不知道就说不知道，实事求是。',
  ]);
  assert.ok(lines.slice(2).every(line => line.startsWith('· ')));
});

test('no wording changes: removing the markers restores the original', () => {
  const out = layoutPersona(SAMPLE);
  assert.equal(out.replace(/^· /gm, '').replace(/\n/g, ''), SAMPLE);
});

test('laying out twice changes nothing', () => {
  const once = layoutPersona(SAMPLE);
  assert.equal(layoutPersona(once), once);
});

test('long sentences break at a comma, never mid-clause', () => {
  const long = `${'这是一段很长的说明，'.repeat(3)}最后一个分句。`;
  const out = layoutPersona(long, { width: 16, bullets: false });
  const lines = out.split('\n');
  assert.ok(lines.length > 1);
  assert.equal(out.replace(/\n/g, ''), long);
  for (const line of lines.slice(0, -1)) {
    assert.ok(line.length <= 17, `line too long: ${line}`);
    assert.equal(line.endsWith('，'), true, `should cut after a comma: ${line}`);
  }
});

test('paragraphs stay separated by a blank line', () => {
  assert.deepEqual(layoutPersona('第一段话。\n\n第二段话。').split('\n'), ['第一段话。', '', '第二段话。']);
});

test('empty and whitespace-only personas stay empty', () => {
  assert.equal(layoutPersona(''), '');
  assert.equal(layoutPersona('   \n  '), '');
});
