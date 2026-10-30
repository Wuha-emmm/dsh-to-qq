import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  voiceSegments,
  extractTranscript,
  audioBytes,
  pickProvider,
  buildCommand,
  transcribeVoice,
  transcribeViaCommand,
} from '../src/media/voice.js';

test('voiceSegments keeps only record segments', () => {
  const segments = [
    { type: 'text', data: { text: '听我说' } },
    { type: 'record', data: { file: 'a.amr' } },
    { type: 'image', data: {} },
    { type: 'record', data: { file: 'b.amr' } },
  ];
  assert.equal(voiceSegments(segments).length, 2);
  assert.deepEqual(voiceSegments(undefined), []);
});

test('extractTranscript accepts the shapes the transport returns', () => {
  assert.equal(extractTranscript({ text: ' 你好 ' }), '你好');
  assert.equal(extractTranscript({ data: { text: '在吗' } }), '在吗');
  assert.equal(extractTranscript('原样文本'), '原样文本');
  assert.equal(extractTranscript({ text: '   ' }), undefined);
  assert.equal(extractTranscript(null), undefined);
});

test('audioBytes prefers base64 and rejects an empty result', async () => {
  const bytes = await audioBytes({ data: { base64: Buffer.from('abc').toString('base64') } });
  assert.equal(Buffer.from(bytes).toString(), 'abc');
  await assert.rejects(() => audioBytes({ data: {} }), /no url or base64/);
});

test('pickProvider prefers a provider that lists the language', () => {
  const providers = [
    { id: 'p1', languages: ['en'] },
    { id: 'p2', languages: ['zh'] },
  ];
  assert.equal(pickProvider(providers, 'zh').id, 'p2');
  assert.equal(pickProvider(providers, 'ja').id, 'p1', 'falls back to the first provider');
  assert.equal(pickProvider([], 'zh'), undefined);
});

test('buildCommand substitutes both placeholders', () => {
  assert.equal(
    buildCommand('whisper -f {input} -l {language}', { input: 'C:\\tmp\\a.wav', language: 'zh' }),
    'whisper -f C:\\tmp\\a.wav -l zh',
  );
});

test('transcribeVoice falls back to the Host speech provider when QQ has no answer', async () => {
  const calls = [];
  const client = {
    call: async action => {
      calls.push(action);
      if (action === 'fetch_ptt_text') return { status: 'failed', wording: '语音转文字超时（未收到结果推送）' };
      return { data: { base64: Buffer.from('wav').toString('base64') } };
    },
  };
  const speech = {
    listProviders: () => [{ id: 'local', languages: ['zh'] }],
    resolve: () => ({ provider: { id: 'local' } }),
    transcribe: async () => ({ text: '语音内容' }),
  };
  const result = await transcribeVoice({ client, speech, segment: { data: { file: 'a.amr' } }, messageId: 1 });
  assert.deepEqual(result, { text: '语音内容', source: 'speech' });
  assert.deepEqual(calls, ['fetch_ptt_text', 'fetch_ptt_text', 'get_record']);
});

test('transcribeVoice falls back to the configured command', async () => {
  const client = {
    call: async () => ({ data: { base64: Buffer.from('wav').toString('base64') } }),
  };
  const speech = { listProviders: () => [], resolve: () => ({}), transcribe: async () => ({ text: '' }) };
  const result = await transcribeVoice({
    client,
    speech,
    segment: { data: { file: 'a.amr' } },
    messageId: 1,
    config: { command: 'echo transcribed-by-command' },
  });
  assert.deepEqual(result, { text: 'transcribed-by-command', source: 'command' });
});

test('transcribeVoice asks QQ as the last resort, and can be told not to', async () => {
  const calls = [];
  const client = {
    call: async (action, params) => {
      calls.push([action, params]);
      return { text: 'QQ 识别结果' };
    },
  };
  const result = await transcribeVoice({ client, segment: undefined, messageId: 42, config: {} });
  assert.deepEqual(result, { text: 'QQ 识别结果', source: 'qq' });
  assert.deepEqual(calls, [['fetch_ptt_text', { message_id: 42 }]]);

  calls.length = 0;
  const skipped = await transcribeVoice({ client, segment: undefined, messageId: 42, config: { qqAsr: false } });
  assert.equal(skipped.text, undefined);
  assert.equal(calls.length, 0, 'QQ ASR is skipped when disabled');
});

test('transcribeVoice returns undefined when every engine is unavailable', async () => {
  const lines = [];
  const client = { call: async () => { throw new Error('语音不在缓存中'); } };
  const result = await transcribeVoice({
    client,
    speech: { listProviders: () => [], resolve: () => ({}), transcribe: async () => ({ text: '' }) },
    segment: { data: { file: 'a.amr' } },
    messageId: 7,
    log: line => lines.push(line),
  });
  assert.equal(result.text, undefined);
  assert.match(result.error, /语音|no speech engine/);
});

test('transcribeViaCommand rejects an empty template', async () => {
  assert.equal(await transcribeViaCommand('', new Uint8Array([1]), { language: 'zh' }), undefined);
});




