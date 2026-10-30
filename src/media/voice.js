/**
 * Voice messages.
 *
 * QQ voice arrives as a `record` segment carrying only a file id; the audio
 * itself comes from `get_record`. Transcription tries, in order:
 *
 * 1. the Host `speechToText` registry (local Whisper providers, when installed),
 * 2. a user-provided command template (for example whisper.cpp),
 * 3. QQ's own `fetch_ptt_text`, which needs QQ to push a result back.
 *
 * Every step degrades to a note, never to a failed turn.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Default recognition language. */
const DEFAULT_LANGUAGE = 'zh';

/**
 * Pick the voice segments of one message.
 *
 * @param {ReadonlyArray<{ type: string, data?: Record<string, unknown> }>} segments Message segments.
 * @returns {Array<{ type: string, data?: Record<string, unknown> }>} Voice segments.
 */
export function voiceSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.filter(segment => segment?.type === 'record');
}

/**
 * Pull the text out of whatever the transport returned.
 *
 * @param {any} result Action result.
 * @returns {string | undefined} Trimmed text, when present.
 */
export function extractTranscript(result) {
  const direct = typeof result === 'string'
    ? result
    : result?.text ?? result?.data?.text ?? result?.message;
  if (typeof direct !== 'string') return undefined;
  const trimmed = direct.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Turn a `get_record` result into raw bytes.
 *
 * @param {any} result Action result; either `base64` or a downloadable `url`/`file`.
 * @returns {Promise<Uint8Array>} Audio bytes.
 */
export async function audioBytes(result) {
  const data = result?.data ?? result ?? {};
  const base64 = typeof data.base64 === 'string' ? data.base64 : '';
  if (base64 !== '') return new Uint8Array(Buffer.from(base64, 'base64'));
  const url = typeof data.url === 'string' && data.url !== '' ? data.url : data.file;
  if (typeof url !== 'string' || url === '') throw new Error('voice record carries no url or base64');
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`voice download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Choose a speech provider for one language.
 *
 * @param {ReadonlyArray<{ id: string, languages?: readonly string[] }>} providers Available providers.
 * @param {string} language Preferred language.
 * @returns {{ id: string } | undefined} The chosen provider.
 */
export function pickProvider(providers, language) {
  if (!Array.isArray(providers) || providers.length === 0) return undefined;
  const exact = providers.find(provider => Array.isArray(provider.languages) && provider.languages.includes(language));
  return exact ?? providers[0];
}

/**
 * Render a command template.
 *
 * @param {string} template Template with `{input}` and `{language}` placeholders.
 * @param {{ input: string, language: string }} values Values to substitute.
 * @returns {string} Ready-to-run command line.
 */
export function buildCommand(template, values) {
  return String(template)
    .replaceAll('{input}', values.input)
    .replaceAll('{language}', values.language);
}

/**
 * Run a command and return its stdout.
 *
 * @param {string} commandLine Full command line; run through the shell.
 * @param {{ timeoutMs?: number }} [options] Limits.
 * @returns {Promise<string>} Trimmed stdout.
 */
async function runCommand(commandLine, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(commandLine, { shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`voice command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`voice command exited ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
}

/**
 * Transcribe through the Host speech registry.
 *
 * @param {any} speech `ctx.speechToText`.
 * @param {Uint8Array} audio Audio bytes.
 * @param {string} language Preferred language.
 * @returns {Promise<string | undefined>} Transcript, or undefined when no provider is usable.
 */
export async function transcribeViaSpeech(speech, audio, language) {
  if (speech === undefined || speech === null) return undefined;
  const providers = typeof speech.listProviders === 'function' ? speech.listProviders() : [];
  const provider = pickProvider(providers, language);
  if (provider === undefined) return undefined;
  const spec = speech.resolve({ audio, language, providerId: provider.id });
  const transcript = await speech.transcribe(spec, AbortSignal.timeout(180_000));
  const text = String(transcript?.text ?? '').trim();
  return text === '' ? undefined : text;
}

/**
 * Transcribe by writing the audio to a temp file and running a command.
 *
 * @param {string} template Command template with `{input}` / `{language}`.
 * @param {Uint8Array} audio Audio bytes.
 * @param {{ language: string, timeoutMs?: number }} options Options.
 * @returns {Promise<string | undefined>} Transcript, or undefined when the output is empty.
 */
export async function transcribeViaCommand(template, audio, options) {
  if (typeof template !== 'string' || template.trim() === '') return undefined;
  const language = options.language ?? DEFAULT_LANGUAGE;
  const directory = await mkdtemp(join(tmpdir(), 'dsh-to-qq-voice-'));
  const input = join(directory, 'voice.wav');
  try {
    await writeFile(input, audio);
    const commandLine = buildCommand(template, { input, language });
    const output = await runCommand(commandLine, { timeoutMs: options.timeoutMs });
    const text = output.trim();
    return text === '' ? undefined : text;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Download the audio behind one `record` segment.
 *
 * @param {{ call: (action: string, params: object, options?: object) => Promise<any> } | undefined} client OneBot client.
 * @param {{ data?: Record<string, unknown> } | undefined} segment The `record` segment.
 * @returns {Promise<Uint8Array | undefined>} Audio bytes.
 */
export async function fetchVoiceAudio(client, segment) {
  if (client === undefined) return undefined;
  const file = segment?.data?.file;
  if (typeof file !== 'string' || file === '') return undefined;
  const result = await client.call('get_record', { file, out_format: 'wav' }, { timeoutMs: 20_000 });
  if (result?.status === 'failed') throw new Error(String(result?.wording ?? 'get_record failed'));
  return await audioBytes(result);
}

/**
 * Transcribe one voice message with the best available engine.
 *
 * @param {object} options Inputs.
 * @param {{ call: (action: string, params: object, options?: object) => Promise<any> } | undefined} options.client OneBot client.
 * @param {any} options.speech Host speech registry, when present.
 * @param {{ data?: Record<string, unknown> } | undefined} options.segment The `record` segment.
 * @param {number | string} options.messageId QQ message id, for QQ's own ASR.
 * @param {{ language?: string, command?: string, qqAsr?: boolean }} [options.config] Voice settings.
 * @param {(line: string) => void} [options.log] Diagnostic sink.
 * @returns {Promise<{ text: string, source: string } | undefined>} Transcript and which engine produced it.
 */
export async function transcribeVoice(options) {
  const log = options.log ?? (() => {});
  const language = options.config?.language ?? DEFAULT_LANGUAGE;
  const client = options.client;
  /** First failure worth showing the user; silent degradation hides real problems. */
  let firstError = '';

  // 1. QQ native ASR. The first call triggers a request whose answer arrives as a
  //    push; once it lands the transport caches it and later calls answer in
  //    milliseconds. A cold call can therefore fail by timeout and still succeed
  //    on the next attempt, so this retries once before falling back.
  if (options.config?.qqAsr !== false && client !== undefined) {
    const id = Number(options.messageId);
    if (Number.isFinite(id)) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const result = await client.call('fetch_ptt_text', { message_id: id }, { timeoutMs: 25_000 });
          if (result?.status === 'failed') {
            firstError = String(result?.wording ?? 'failed');
            log(`voice: qq asr attempt ${attempt} failed: ${firstError}`);
          } else {
            const text = extractTranscript(result);
            if (text !== undefined) return { text, source: 'qq' };
          }
        } catch (error) {
          firstError = String(error?.message ?? error);
          log(`voice: qq asr attempt ${attempt} threw: ${firstError}`);
        }
        if (attempt === 1) await new Promise(resolve => setTimeout(resolve, 1_500));
      }
    }
  }

  // 2. A local speech provider: no dependency on the push at all.
  if (options.speech !== undefined && options.speech !== null && client !== undefined) {
    try {
      const audio = await fetchVoiceAudio(client, options.segment);
      if (audio !== undefined) {
        const text = await transcribeViaSpeech(options.speech, audio, language);
        if (text !== undefined) return { text, source: 'speech' };
      }
    } catch (error) {
      if (firstError === '') firstError = String(error?.message ?? error);
      log(`voice: speech provider failed: ${error?.message ?? error}`);
    }
  }

  // 3. A user-provided command (whisper.cpp and friends).
  const command = options.config?.command ?? "";
  if (command !== '' && client !== undefined) {
    try {
      const audio = await fetchVoiceAudio(client, options.segment);
      if (audio !== undefined) {
        const text = await transcribeViaCommand(command, audio, { language });
        if (text !== undefined) return { text, source: 'command' };
      }
    } catch (error) {
      if (firstError === '') firstError = String(error?.message ?? error);
      log(`voice: command failed: ${error?.message ?? error}`);
    }
  }

  return { text: undefined, error: firstError === '' ? 'no speech engine available' : firstError };
}

