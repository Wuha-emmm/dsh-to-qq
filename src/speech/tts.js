/**
 * DeepSeek text to speech: turn a line of text into audio QQ can send as a
 * voice message.
 *
 * One request carries the whole text and the whole audio comes back; the API
 * has no streaming form worth using here, because a voice message is never
 * played until it is complete anyway.
 */

const TEXT_LIMIT = 10_000;
const BODY_LIMIT = 64 * 1024;

/**
 * Pick a file extension for the bytes the API returned.
 *
 * @param {string} mime Content type header.
 * @returns {string} Extension without the dot.
 */
function extensionOf(mime) {
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('ogg') || mime.includes('opus')) return 'ogg';
  return 'wav';
}

/**
 * Synthesize speech.
 *
 * @param {object} options Wiring.
 * @param {string} options.apiKey DeepSeek API key (`sk-…`).
 * @param {string} [options.baseUrl] API root.
 * @param {string} [options.voiceId] `stella` (female) or `tide` (male).
 * @param {string} [options.format] `wav` or `pcm`.
 * @param {string} options.text What to say.
 * @param {number} [options.timeoutMs] Request timeout.
 * @returns {Promise<{ bytes: Buffer, mime: string, extension: string, voiceId: string }>} The audio.
 */
export async function synthesizeSpeech(options) {
  const key = String(options?.apiKey ?? '').trim();
  if (key === '') {
    throw new Error('语音还没配 key：在设置里填 speech.apiKey（DeepSeek API key，sk- 开头）。');
  }
  const text = String(options?.text ?? '').trim();
  if (text === '') throw new Error('要念什么？给我一句话。');
  if (text.length > TEXT_LIMIT) throw new Error(`一次最多念 ${TEXT_LIMIT} 个字符，这段太长了。`);
  const voiceId = String(options?.voiceId ?? '').trim() || 'stella';
  const format = String(options?.format ?? '').trim() === 'pcm' ? 'pcm' : 'wav';
  const root = (String(options?.baseUrl ?? '').trim() || 'https://api.deepseek.com').replace(/\/+$/, '');
  const body = JSON.stringify({ text, voice_id: voiceId, format });
  if (Buffer.byteLength(body) > BODY_LIMIT) throw new Error('这段文本太长，请求体超过了 64 KiB。');

  const response = await fetch(`${root}/v1/tools/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body,
    signal: AbortSignal.timeout(Number(options?.timeoutMs ?? 120_000)),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`语音合成失败 ${response.status}：${detail.slice(0, 300)}`);
  }

  const mime = String(response.headers.get('content-type') ?? '').toLowerCase();
  if (mime.includes('json')) {
    // A JSON body means either an error object or base64 audio; handle both so
    // a format change on the provider side does not look like a broken feature.
    const payload = await response.json().catch(() => ({}));
    const encoded = payload.audio ?? payload.data ?? payload.base64;
    if (typeof encoded === 'string' && encoded !== '') {
      return { bytes: Buffer.from(encoded, 'base64'), mime: 'audio/wav', extension: 'wav', voiceId };
    }
    throw new Error(`语音合成返回了 JSON：${JSON.stringify(payload).slice(0, 300)}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error('语音合成返回了空文件。');
  if (format === 'pcm') {
    // Raw PCM has no header; wrap it so players and the silk encoder agree.
    return { bytes: wavFromPcm(bytes), mime: 'audio/wav', extension: 'wav', voiceId };
  }
  return { bytes, mime: mime || 'audio/wav', extension: extensionOf(mime), voiceId };
}

/**
 * Wrap 24 kHz 16-bit mono PCM in a WAV header.
 *
 * @param {Buffer} pcm Raw samples.
 * @returns {Buffer} A playable WAV file.
 */
export function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(24_000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
