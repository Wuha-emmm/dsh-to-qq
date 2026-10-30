/**
 * Card renderer shared by the memory card and the group digest.
 *
 * Both are the same visual: a template PNG (backdrop + panel), a portrait on the
 * left, and two equal halves of text on the right. Only the payload differs.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Script that draws the card. */
const SCRIPT = fileURLToPath(new URL('./memory-card.ps1', import.meta.url));

/** 30-second memo: the same card is often requested twice in a row. */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 20;
/** @type {Map<string, { at: number, payload: string }>} */
const RENDER_CACHE = new Map();

/**
 * Run the renderer.
 *
 * @param {string} dataPath JSON input.
 * @param {string} outPath PNG output.
 * @param {string} avatarPath Downloaded portrait, or an empty string.
 * @param {string} backdropPath Backdrop, or an empty string.
 * @param {string} templatePath Cached template, or an empty string.
 * @returns {Promise<void>} Resolves when the PNG exists.
 */
function runRenderer(dataPath, outPath, avatarPath, backdropPath, templatePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      '-DataPath', dataPath,
      '-OutPath', outPath,
      '-AvatarPath', avatarPath,
      '-BackdropPath', backdropPath,
      '-TemplatePath', templatePath,
    ], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`card render failed (${code}): ${stderr.slice(0, 200)}`));
    });
  });
}

/**
 * Download an image, ignoring every failure (the card draws a placeholder).
 *
 * @param {string} url Image URL.
 * @param {string} directory Where to save it.
 * @returns {Promise<string>} Path to the image, or an empty string.
 */
async function fetchImage(url, directory) {
  if (typeof url !== 'string' || url === '') return '';
  const target = join(directory, 'portrait.img');
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return '';
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 64) return '';
    await writeFile(target, bytes);
    return target;
  } catch {
    return '';
  }
}

/**
 * Find a backdrop image: a per-scene one first, then a shared `backdrop.*`.
 *
 * @param {string | undefined} directory Media directory.
 * @param {number} key QQ number or group id, for the per-scene file.
 * @returns {Promise<string>} Path to the image, or an empty string.
 */
async function findBackdrop(directory, key) {
  if (typeof directory !== 'string' || directory === '') return '';
  const { stat } = await import('node:fs/promises');
  const candidates = [
    `backdrop-${key}.png`, `backdrop-${key}.jpg`,
    'backdrop.png', 'backdrop.jpg', 'backdrop.jpeg', 'backdrop.webp',
  ];
  for (const name of candidates) {
    const candidate = join(directory, name);
    try {
      const info = await stat(candidate);
      if (info.isFile() && info.size > 1024) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return '';
}

/**
 * Work out which template file to use, dropping a stale one.
 *
 * There are two templates — one per card kind — so the group card's missing
 * divider can never leak into a personal card.
 *
 * @param {string | undefined} directory Media directory.
 * @param {string} backdropPath Backdrop in use, or an empty string.
 * @param {'personal' | 'group'} kind Which template.
 * @returns {Promise<string>} Template path, or an empty string to render inline.
 */
async function prepareTemplate(directory, backdropPath, kind) {
  if (typeof directory !== 'string' || directory === '') return '';
  const { stat } = await import('node:fs/promises');
  const template = join(directory, `card-template-${kind}.png`);
  const templateInfo = await stat(template).catch(() => undefined);
  if (templateInfo === undefined) return template;
  if (backdropPath === '') return template;
  const backdropInfo = await stat(backdropPath).catch(() => undefined);
  if (backdropInfo !== undefined && backdropInfo.mtimeMs > templateInfo.mtimeMs) {
    await rm(template, { force: true }).catch(() => {});
  }
  return template;
}

/**
 * Render one prepared payload.
 *
 * @param {object} payload Text fields for the card.
 * @param {{ avatarUrl?: string, backdropDir?: string, log?: (line: string) => void }} options Wiring.
 * @returns {Promise<string>} A `base64://` payload OneBot accepts as an image.
 */
/**
 * Draw one card, reusing a recent identical render.
 *
 * @param {any} payload Render request.
 * @param {{ avatarUrl?: string, backdropDir?: string, log?: (line: string) => void }} [options] Wiring.
 * @returns {Promise<string>} A `base64://` payload.
 */
async function renderPayload(payload, options = {}) {
  const key = JSON.stringify([payload, options.avatarUrl ?? '', options.backdropDir ?? '']);
  const now = Date.now();
  const hit = RENDER_CACHE.get(key);
  if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return hit.payload;
  const rendered = await renderPayloadUncached(payload, options);
  RENDER_CACHE.set(key, { at: now, payload: rendered });
  if (RENDER_CACHE.size > CACHE_MAX) {
    for (const [oldKey, entry] of RENDER_CACHE) {
      if (RENDER_CACHE.size <= CACHE_MAX) break;
      if (now - entry.at >= CACHE_TTL_MS) RENDER_CACHE.delete(oldKey);
    }
    // Still too many live entries: drop the oldest insertion.
    while (RENDER_CACHE.size > CACHE_MAX) {
      const oldest = RENDER_CACHE.keys().next().value;
      RENDER_CACHE.delete(oldest);
    }
  }
  return rendered;
}

async function renderPayloadUncached(payload, options = {}) {
  const log = options.log ?? (() => {});
  const directory = await mkdtemp(join(tmpdir(), 'dsh-qq-card-'));
  const dataPath = join(directory, 'card.json');
  const outPath = join(directory, 'card.png');
  try {
    const portrait = await fetchImage(options.avatarUrl ?? '', directory);
    const backdropPath = await findBackdrop(options.backdropDir, Number(payload.sceneKey ?? 0));
    const templatePath = await prepareTemplate(
      options.backdropDir,
      backdropPath,
      payload.template === 'group' ? 'group' : 'personal',
    );
    await writeFile(dataPath, JSON.stringify(payload), 'utf8');
    await runRenderer(dataPath, outPath, portrait, backdropPath, templatePath);
    const png = await readFile(outPath);
    log(`card rendered: ${png.length} bytes`);
    return `base64://${png.toString('base64')}`;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Draw one memory card.
 *
 * @param {{ qq: number, name?: string, persona?: string, notes?: Array<{ at: number, text: string }>, admin?: boolean, sceneLabel?: string }} card Card data.
 * @param {{ log?: (line: string) => void, backdropDir?: string }} [options] Wiring.
 * @returns {Promise<string>} A `base64://` payload.
 */
/**
 * Lay out the persona block so a run-on paragraph reads like speech, not a wall.
 *
 * Only line breaks are inserted; every character of the original sentence stays.
 * Sentences end a line, long sentences break at a comma when one is close to the
 * limit, and blank lines separate the paragraphs the owner wrote.
 *
 * @param {string} text Persona text from the card.
 * @param {{ width?: number }} [options] Soft line width in characters.
 * @returns {string} Text with newlines, ready for the renderer.
 */
/**
 * Lay out the persona block so a run-on paragraph reads like speech, not a wall.
 *
 * Only line breaks and bullet markers are added; every character of the original
 * sentence stays. The first sentence stays a lead-in, the rest become bullets,
 * long sentences break at a comma, and blank lines separate real paragraphs.
 *
 * @param {string} text Persona text from the card.
 * @param {{ width?: number, bullets?: boolean }} [options] Layout options.
 * @returns {string} Text with newlines, ready for the renderer.
 */
export function layoutPersona(text, options = {}) {
  const width = Math.max(12, Math.min(60, Number(options.width) || 30));
  const bullets = options.bullets !== false;
  const raw = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (raw === '') return '';

  const lines = [];
  // A blank line marks a real paragraph; a single newline is just a line break
  // the owner typed, so the function stays idempotent when called twice.
  const paragraphs = raw.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    const segments = paragraph.split(/\n/).map(part => part.trim()).filter(Boolean);
    // Already a bullet list (our own output, or a persona the owner wrote that
    // way): keep every item a bullet and skip the lead-in handling.
    const alreadyList = segments.length > 0 && segments.every(part => /^[·•\-]\s*/.test(part));
    const sentences = [];
    for (const segment of segments) {
      const clean = segment.replace(/^[·•\-]\s*/, '').trim();
      if (clean === '') continue;
      const found = clean.match(/[^。！？；!?;]+[。！？；!?;]?/g) ?? [clean];
      for (const sentence of found) {
        const piece = sentence.trim();
        if (piece !== '') sentences.push(piece);
      }
    }
    if (sentences.length === 0) continue;

    if (alreadyList) {
      for (const sentence of sentences) {
        splitLongSentence(sentence, bullets ? width - 2 : width).forEach(piece => {
          lines.push(bullets ? `· ${piece}` : piece);
        });
      }
      lines.push('');
      continue;
    }

    lines.push(...splitLongSentence(sentences[0], width));
    const rest = sentences.slice(1);
    if (rest.length > 0) {
      if (bullets) lines.push('');
      for (const sentence of rest) {
        const pieces = splitLongSentence(sentence, bullets ? width - 2 : width);
        pieces.forEach((piece, index) => {
          lines.push(index === 0 && bullets ? `· ${piece}` : piece);
        });
      }
    }
    // Blank line between the paragraphs the owner actually wrote.
    lines.push('');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Break one sentence at clause punctuation, never inside a clause.
 *
 * @param {string} sentence One sentence including its final punctuation.
 * @param {number} width Soft limit in characters.
 * @returns {string[]} Pieces, each at most ~width characters.
 */
function splitLongSentence(sentence, width) {
  const chars = [...sentence];
  if (chars.length <= width) return [sentence];
  const pieces = [];
  let rest = chars;
  while (rest.length > width) {
    let cut = -1;
    for (let index = Math.min(width, rest.length - 1); index >= Math.floor(width * 0.55); index -= 1) {
      if ('，、,：:'.includes(rest[index])) { cut = index + 1; break; }
    }
    if (cut <= 0) cut = width;
    pieces.push(rest.slice(0, cut).join('').trim());
    rest = rest.slice(cut);
    while (rest.length > 0 && rest[0] === ' ') rest = rest.slice(1);
  }
  if (rest.length > 0) pieces.push(rest.join('').trim());
  return pieces.filter(piece => piece !== '');
}

export async function renderMemoryCard(card, options = {}) {
  const notes = Array.isArray(card.notes) ? card.notes : [];
  const noteCount = notes.length;
  const role = card.admin === true ? '管理员' : '访客';
  return renderPayload({
    template: 'personal',
    sceneKey: card.qq,
    qq: card.qq,
    title: `${card.name ?? ''}（QQ ${card.qq}）`,
    subtitle: `${noteCount} 条笔记 · ${role}`,
    personaLabel: '我该怎么跟你说话',
    persona: layoutPersona(String(card.persona ?? '')),
    notesLabel: '我对你的印象',
    // The renderer draws top-down; show the newest note first.
    notes: [...notes].reverse(),
    emptyPersona: '（你还没给我定过调子，我按默认来）',
    emptyNotes: '（还没记住什么）',
    sceneLabel: card.sceneLabel ?? '',
    footer: '改人设：在QQ里发「/人设 你的要求」\n「我对你的印象」由我记录，你改不了',
  }, {
    avatarUrl: Number.isInteger(card.qq) && card.qq > 0 ? `https://q1.qlogo.cn/g?b=qq&nk=${card.qq}&s=640` : '',
    backdropDir: options.backdropDir,
    log: options.log,
  });
}

/**
 * Draw the daily digest of one group, on the same template.
 *
 * @param {{ gid: number, name?: string, dayLabel: string, summary: { total: number, senders: number, top: Array<[string, number]>, peakHour: number, peakCount: number, images: number, voices: number } }} info Digest facts.
 * @param {{ log?: (line: string) => void, backdropDir?: string }} [options] Wiring.
 * @returns {Promise<string>} A `base64://` payload.
 */
export async function renderDigestCard(info, options = {}) {
  const { summary } = info;
  const name = info.name !== undefined && info.name !== '' ? info.name : `群 ${info.gid}`;
  const facts = [`消息 ${summary.total} 条，${summary.senders} 人参与`];
  if (summary.avgPerSender > 0) {
    facts.push(`人均 ${summary.avgPerSender} 条，平均每条 ${summary.avgChars} 字`);
  }
  if (summary.peakCount > 0) {
    facts.push(`最热闹 ${String(summary.peakHour).padStart(2, '0')}:00 前后（${summary.peakCount} 条）`);
  }
  if (summary.images > 0 || summary.voices > 0) {
    const media = [];
    if (summary.images > 0) media.push(`图片 ${summary.images}`);
    if (summary.voices > 0) media.push(`语音 ${summary.voices}`);
    facts.push(media.join('，'));
  }
  if (summary.longest > 0) facts.push(`最长一条 ${summary.longest} 字`);
  // The renderer aligns the count on its own, so a long name is truncated
  // without chopping the number.
  const ranking = summary.top.map(([sender, count]) => ({ text: sender, count: `${count} 条` }));
  return renderPayload({
    template: 'group',
    sceneKey: info.gid,
    qq: info.gid,
    title: name,
    subtitle: `${info.dayLabel} · ${summary.total} 条消息`,
    personaLabel: '今天发生了什么',
    persona: facts.join('\n'),
    notesLabel: '发言排行',
    notes: ranking,
    notesColumns: 2,
    split: 0.62,
    hours: Array.isArray(summary.hours) ? summary.hours : [],
    emptyPersona: '（今天群里很安静）',
    emptyNotes: '（没有人发言）',
    sceneLabel: '群日报',
    footer: '统计自本群今天的消息\n只算我缓存到的部分',
  }, {
    avatarUrl: `https://p.qlogo.cn/gh/${info.gid}/${info.gid}/640`,
    backdropDir: options.backdropDir,
    log: options.log,
  });
}
