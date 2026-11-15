import test from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeSpeech, wavFromPcm } from '../src/speech/tts.js';
import { defaults, mergeConfig } from '../src/config/defaults.js';
import { TIER_TOOLS } from '../src/policy/restrictions.js';

test('speech defaults point at the DeepSeek voice API', () => {
  const config = defaults();
  assert.equal(config.speech.provider, 'deepseek');
  assert.equal(config.speech.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.speech.voiceId, 'stella');
  assert.equal(config.speech.format, 'wav');
  assert.equal(config.speech.apiKey, '');
});

test('a hand-edited speech section is repaired instead of trusted', () => {
  const config = mergeConfig({
    speech: { voiceId: 'robot', format: 'flac', apiKey: 7, provider: 'openai' },
  });
  assert.equal(config.speech.provider, 'deepseek');
  assert.equal(config.speech.voiceId, 'stella');
  assert.equal(config.speech.format, 'wav');
  assert.equal(config.speech.apiKey, '');
});

test('an existing key and voice survive the merge', () => {
  const config = mergeConfig({ speech: { apiKey: 'sk-test', voiceId: 'tide' } });
  assert.equal(config.speech.apiKey, 'sk-test');
  assert.equal(config.speech.voiceId, 'tide');
});

test('synthesizeSpeech refuses to run without a key or text', async () => {
  await assert.rejects(() => synthesizeSpeech({ text: '你好' }), /speech\.apiKey/);
  await assert.rejects(() => synthesizeSpeech({ apiKey: 'sk-test', text: '  ' }), /要念什么/);
});

test('raw PCM gets a WAV header so players and silk accept it', () => {
  const pcm = Buffer.alloc(480); // 10ms of 24kHz 16-bit mono
  const wav = wavFromPcm(pcm);
  assert.equal(wav.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('latin1'), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.length, 44 + pcm.length);
});

test('the administrator can speak, guests cannot', () => {
  assert.ok(TIER_TOOLS['owner-group'].includes('qq_voice'));
  assert.ok(!TIER_TOOLS.member.includes('qq_voice'));
  assert.ok(!TIER_TOOLS['member-group'].includes('qq_voice'));
});

import { speechify } from '../src/speech/style.js';

test('markup is stripped, never read out loud', () => {
  const spoken = speechify('**好的**，看 `E:\\out.txt` 这个文件\n- 第一行\n- 第二行');
  assert.ok(!spoken.includes('*'));
  assert.ok(!spoken.includes('`'));
  assert.ok(!spoken.includes('- '));
  assert.ok(spoken.includes('E:\\out.txt'));
});

test('a long sentence gets a breath in the middle', () => {
  const spoken = speechify('这台机器的显卡是五零七零十二个G显存跑量化版模型其实还算够用但是别指望跑满血版本');
  assert.ok(spoken.length > 26);
  assert.ok((spoken.match(/，/g) ?? []).length >= 1);
});

test('a sentence without punctuation still ends like a sentence', () => {
  assert.ok(speechify('你好').endsWith('。'));
  assert.ok(speechify('你在干嘛').endsWith('。'));
});

test('tone bends only the closing punctuation', () => {
  assert.ok(speechify('好', { tone: '开心' }).endsWith('！'));
  assert.ok(speechify('好', { tone: '难过' }).endsWith('…'));
  assert.ok(speechify('好', { tone: '随便' }).endsWith('。'));
});

test('empty or markup-only text has nothing to say', () => {
  assert.equal(speechify(''), '');
  assert.equal(speechify('```\ncode only\n```'), '');
});
