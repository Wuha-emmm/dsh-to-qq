/**
 * `qq_cover`: turn a whole song into her voice.
 *
 * The heavy lifting lives in `python/feiyu_cover.py` (demucs separates the
 * vocals, the FeiyuVoice-RVC package moves them to her timbre, the instrumental
 * is mixed back). This tool finds the installation, prepares the source, runs
 * it once, and either sends the result or reports where it landed.
 *
 * Two shapes of source:
 *   - `audio`: a local file, the one the person just sent;
 *   - `source`: a Bilibili link or BV id, downloaded here with yt-dlp.
 *
 * With `video` the original picture is muxed back under her singing, so the
 * answer is a finished clip instead of a bare audio file.
 */

import { spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';

const READY_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 900_000;
const MUX_TIMEOUT_MS = 900_000;

/** Where the tools usually sit on this machine; PATH is the fallback. */
const FFMPEG_CANDIDATES = [
  'C:\\Users\\Administrator\\.dsh\\tools\\ffmpeg\\ffmpeg.exe',
  'E:\\DSH-herself\\tools\\ffmpeg\\ffmpeg.exe',
];

const PYTHON_CANDIDATES = [
  'C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
];

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.flv', '.mov', '.ts']);

/**
 * Register the cover tool.
 *
 * @param {object} ctx Plugin context (needs `tools`).
 * @param {object} options Wiring.
 * @param {any} options.bridge The bridge (exposes `localVoice`).
 * @param {(line: string) => void} [options.log] Diagnostic sink.
 * @param {(command: string, args: string[]) => import('node:child_process').ChildProcess} [options.spawnImpl]
 *   Spawn hook, for tests.
 * @returns {() => void} Disposer.
 */
export function registerQqCoverTool(ctx, options) {
  const spawnImpl = options.spawnImpl ?? spawn;

  return ctx.tools.register({
    name: 'qq_cover',
    description:
      'Cover a song in her voice: separate the original vocals and instrumental, move the singing to her timbre, mix them back. '
      + 'Give it either a local audio path (`audio`, the file the person just sent) or a Bilibili link / BV id (`source`, downloaded here). '
      + 'Set `video` to mux the original picture back under her singing and post the finished clip. '
      + 'Use it whenever someone says 翻唱这首 / 唱一下 / 翻唱这个 / 换成她的声音 and names or quotes a song, with or without a link — '
      + 'do not ask for a download first and do not tell them the machine cannot fetch it. '
      + 'Takes seconds to a couple of minutes on a full song and needs the local Feiyu installation; use qq_voice for plain speech.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        audio: { type: 'string', description: 'Absolute path of the source song (wav / flac / mp3).' },
        source: {
          type: 'string',
          description: 'Bilibili video URL, b23.tv short link, or bare BV id (e.g. BV1XF4m1K7J7) to download and cover.',
        },
        video: {
          type: 'boolean',
          description: 'Mux the original picture back under the cover and post the mp4 as a file. Use it when they asked to 合成视频 / 发视频.',
        },
        keepVocalsOnly: { type: 'boolean', description: 'Return just her isolated singing, without the backing track.' },
        pitch: {
          type: 'integer',
          description: 'Semitones to lift the vocal before the timbre swap. Leave it out (auto) — a male lead is detected and lifted an octave.',
        },
        asVoice: {
          type: 'boolean',
          description: 'Send the cover straight into the chat as a QQ voice message. Only for short clips (a minute or less); a full song will not fit and should be a file instead.',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args = {}, exec) {
      const bridge = options.bridge;
      const local = bridge.localVoice;
      if (local === undefined) throw new Error('本地声音模块没有接上（插件版本太旧？）');

      const root = local.root();
      if (root === '') {
        throw new Error('设置里还没填安装目录（speech.local.root），先填上 E:\\feiyu 这类路径。');
      }
      const python = join(root, 'envs', 'rvc', 'Scripts', 'python.exe');
      if (!existsSync(python)) throw new Error(`找不到 RVC 环境：${python}`);
      const script = local.coverScript();
      if (!existsSync(script)) throw new Error(`找不到翻唱脚本：${script}`);

      const context = typeof bridge.sessionContext === 'function'
        ? bridge.sessionContext(String(exec?.agent?.id ?? ''))
        : undefined;
      const hasContext = context !== undefined;

      const work = join(tmpdir(), 'dsh-to-qq-cover', String(Date.now()));
      mkdirSync(work, { recursive: true });

      let source = String(args.audio ?? '').trim();
      const remote = String(args.source ?? '').trim();
      const wantVideo = args.video === true;
      let videoFile = '';
      let downloadMs = 0;

      if (source === '' && remote !== '') {
        const started = Date.now();
        options.log?.(`qq_cover: downloading ${remote}`);
        const fetched = await fetchSource(spawnImpl, remote, work, line => options.log?.(line));
        source = fetched.audio;
        videoFile = fetched.video;
        downloadMs = Date.now() - started;
        options.log?.(`qq_cover: downloaded ${source}${videoFile === '' ? '' : ` + ${videoFile}`} in ${downloadMs}ms`);
      }
      if (source === '') throw new Error('没有给歌曲：给个本地路径，或者一个 B 站链接 / BV 号。');
      if (!existsSync(source)) throw new Error(`找不到这个文件：${source}`);

      const wav = await toWav(spawnImpl, source, work);
      const output = join(work, 'cover.wav');
      const argv = ['-B', script, '--input', wav, '--output', output, '--root', root, '--mp3'];
      if (args.keepVocalsOnly === true) argv.push('--vocals-only');
      if (Number.isFinite(Number(args.pitch))) argv.push('--pitch', String(Math.trunc(Number(args.pitch))));

      const timeout = Number(local.config().coverTimeoutMs ?? 1_800_000);
      options.log?.(`qq_cover: ${wav} -> ${output} (timeout ${Math.round(timeout / 1000)}s)`);
      const started = Date.now();
      const run = await runOnce(spawnImpl, python, argv, timeout, line => options.log?.(line));
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (run.code !== 0) {
        const tail = run.lines.slice(-8).join('\n');
        throw new Error(`翻唱失败（退出码 ${run.code}）：\n${tail}`);
      }
      let result;
      for (let index = run.lines.length - 1; index >= 0; index -= 1) {
        const line = run.lines[index].trim();
        if (!line.startsWith('{')) continue;
        try {
          result = JSON.parse(line);
          break;
        } catch {
          // keep looking
        }
      }
      if (result === undefined) throw new Error(`翻唱跑完了但没读到结果：\n${run.lines.slice(-6).join('\n')}`);
      const coverWav = String(result.output ?? output);
      const mp3 = coverWav.replace(/\.wav$/i, '.mp3');

      let clip = '';
      if (wantVideo && videoFile !== '' && hasContext) {
        clip = await mux(spawnImpl, videoFile, coverWav, join(work, 'cover.mp4'), line => options.log?.(line));
        options.log?.(`qq_cover: muxed ${clip}`);
      }

      let sentAsVoice = false;
      let sentAsFile = false;
      if (hasContext && clip !== '') {
        await bridge.sendFileToScene(context.scene, clip, `翻唱-${basename(clip)}`);
        sentAsFile = true;
      } else if (hasContext && args.asVoice === true) {
        await bridge.sendVoiceToScene(context.scene, coverWav);
        sentAsVoice = true;
      }

      const deliverable = clip !== '' ? clip : existsSync(mp3) ? mp3 : coverWav;
      const size = sendableSize(deliverable);
      const report = [
        `翻唱完成，用了 ${seconds} 秒${downloadMs === 0 ? '' : `（下载另算 ${(downloadMs / 1000).toFixed(1)} 秒）`}。`,
        `文件：${deliverable}${size === 0 ? '' : `（${(size / 1024 / 1024).toFixed(1)} MB）`}`,
        sentAsFile
          ? '视频已经发出去了。'
          : sentAsVoice
            ? '已经作为语音条发出去了。'
            : '整首歌语音条放不下，用 qq_send 把文件发过去。',
      ].join('\n');
      return {
        report,
        output: coverWav,
        mp3: existsSync(mp3) ? mp3 : '',
        clip,
        seconds: Number(seconds),
        sentAsVoice,
        sentAsFile,
      };
    },
  });
}

/**
 * File size, or zero when the file is gone.
 *
 * @param {string} path Absolute path.
 * @returns {number} Bytes.
 */
function sendableSize(path) {
  try {
    return readFileSync(path).length;
  } catch {
    return 0;
  }
}

/**
 * The ffmpeg binary: a known install first, then PATH.
 *
 * @returns {string} Command to spawn.
 */
function ffmpegPath() {
  for (const candidate of FFMPEG_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return 'ffmpeg';
}

/**
 * The python that has yt-dlp, or `yt-dlp` itself.
 *
 * @returns {{ command: string, prefix: string[] }} How to run it.
 */
function ytdlpCommand() {
  for (const candidate of PYTHON_CANDIDATES) {
    if (existsSync(candidate)) return { command: candidate, prefix: ['-m', 'yt_dlp'] };
  }
  return { command: 'yt-dlp', prefix: [] };
}

/**
 * Download a Bilibili video: the picture and the audio track.
 *
 * Tries the merged 1080p stream first so the mux step has both parts; falls
 * back to audio only, which still allows an audio cover.
 *
 * @param {typeof spawn} spawnImpl Spawn hook.
 * @param {string} reference URL or BV id.
 * @param {string} work Scratch directory.
 * @param {(line: string) => void} [log] Line sink.
 * @returns {Promise<{ audio: string, video: string }>} Absolute paths.
 */
async function fetchSource(spawnImpl, reference, work, log) {
  const { command, prefix } = ytdlpCommand();
  const url = normalizeReference(reference);
  const target = join(work, 'source.%(ext)s');
  const fallbacks = [
    ['-f', 'bv*[height<=1080]+ba/b', '--no-playlist'],
    ['-f', 'ba/b', '--no-playlist'],
  ];
  let last = '';
  for (const flags of fallbacks) {
    const run = await runOnce(spawnImpl, command, [...prefix, ...flags, '-o', target, url], DOWNLOAD_TIMEOUT_MS, log);
    if (run.code === 0) break;
    last = run.lines.slice(-6).join('\n');
  }
  const files = readdirSync(work).filter(name => name.startsWith('source.'));
  const audio = files.find(name => !VIDEO_EXT.has(extOf(name)));
  const video = files.find(name => VIDEO_EXT.has(extOf(name)));
  if (audio === undefined && video === undefined) {
    throw new Error(`下载失败：${last === '' ? '什么都没拿到' : last}`);
  }
  const audioFile = audio !== undefined ? join(work, audio) : join(work, video);
  return { audio: audioFile, video: video === undefined ? '' : join(work, video) };
}

/**
 * Turn a bare BV / av id into a watch URL; leave real URLs alone.
 *
 * yt-dlp refuses a naked `BV1…` with `is not a valid URL`, and people type the
 * id about as often as they paste the link.
 *
 * @param {string} reference What the person gave.
 * @returns {string} A URL yt-dlp accepts.
 */
function normalizeReference(reference) {
  const value = reference.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^BV[0-9A-Za-z]{10}$/.test(value)) return `https://www.bilibili.com/video/${value}`;
  if (/^av\d+$/i.test(value)) return `https://www.bilibili.com/video/${value.toLowerCase()}`;
  if (/^(www\.|b23\.tv|bilibili\.com)/i.test(value)) return `https://${value}`;
  return value;
}

/**
 * Lowercase extension including the dot.
 *
 * @param {string} name File name.
 * @returns {string} Extension.
 */
function extOf(name) {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

/**
 * Make sure demucs gets a wav: it cannot read m4a without ffmpeg on PATH.
 *
 * @param {typeof spawn} spawnImpl Spawn hook.
 * @param {string} source Input file.
 * @param {string} work Scratch directory.
 * @returns {Promise<string>} A wav path.
 */
async function toWav(spawnImpl, source, work) {
  if (extOf(source) === '.wav') return source;
  const output = join(work, 'source.wav');
  const run = await runOnce(
    spawnImpl,
    ffmpegPath(),
    ['-y', '-i', source, '-ac', '2', '-ar', '44100', output],
    MUX_TIMEOUT_MS,
    () => {},
  );
  if (run.code !== 0 || !existsSync(output)) {
    throw new Error(`转 wav 失败：\n${run.lines.slice(-6).join('\n')}`);
  }
  return output;
}

/**
 * Put her singing under the original picture.
 *
 * AV1 from Bilibili does not play in every QQ client, so the picture is always
 * re-encoded to H.264 and scaled to 720p while the audio stays untouched.
 *
 * @param {typeof spawn} spawnImpl Spawn hook.
 * @param {string} video Source video.
 * @param {string} audio Cover audio.
 * @param {string} output Target mp4.
 * @param {(line: string) => void} [log] Line sink.
 * @returns {Promise<string>} The mp4 path.
 */
async function mux(spawnImpl, video, audio, output, log) {
  const args = [
    '-y',
    '-i', video,
    '-i', audio,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-vf', 'scale=1280:-2',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '27',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    output,
  ];
  const run = await runOnce(spawnImpl, ffmpegPath(), args, MUX_TIMEOUT_MS, log);
  if (run.code !== 0 || !existsSync(output)) {
    throw new Error(`合成视频失败：\n${run.lines.slice(-6).join('\n')}`);
  }
  return output;
}

/**
 * Run one child process and collect its output lines.
 *
 * @param {typeof spawn} spawnImpl Spawn hook.
 * @param {string} command Binary to run.
 * @param {string[]} argv Arguments.
 * @param {number} timeoutMs Hard limit.
 * @param {(line: string) => void} log Line sink.
 * @returns {Promise<{ code: number, lines: string[] }>} Exit code and captured lines.
 */
function runOnce(spawnImpl, command, argv, timeoutMs, log) {
  return new Promise(resolve => {
    const child = spawnImpl(command, argv, { windowsHide: true });
    const lines = [];
    const collect = chunk => {
      for (const raw of String(chunk).split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (line === '') continue;
        lines.push(line);
        if (lines.length > 400) lines.shift();
        log(line);
      }
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', collect);
    child.stderr?.on?.('data', collect);
    const timer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {
        // already gone
      }
      resolve({ code: -1, lines });
    }, Math.max(timeoutMs, READY_TIMEOUT_MS));
    child.once?.('error', error => {
      clearTimeout(timer);
      lines.push(`spawn failed: ${error.message}`);
      resolve({ code: -1, lines });
    });
    child.once?.('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, lines });
    });
  });
}
