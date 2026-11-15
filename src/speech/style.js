/**
 * Turn a written line into something worth listening to.
 *
 * The TTS engine takes no emotion, speed, or style argument, so everything a
 * listener hears as feeling has to come from the text itself: short spoken
 * clauses, real punctuation, and no markup read out loud as "star star".
 *
 * This is a rewrite, not a reword: no words are invented, so what is spoken is
 * still exactly what the person was told.
 */

const TONE_CLOSERS = {
  cheer: '！',
  sad: '…',
  angry: '！',
};

/**
 * Normalize a tone word the model may pass.
 *
 * @param {string} tone Whatever was passed.
 * @returns {string} `cheer`, `sad`, `angry`, or an empty string.
 */
function normalizeTone(tone) {
  const raw = String(tone ?? '').trim().toLowerCase();
  if (raw === '') return '';
  if (/开心|高兴|兴奋|欢快|cheer|happy|excite/.test(raw)) return 'cheer';
  if (/难过|低落|失落|沮丧|sad|down|low/.test(raw)) return 'sad';
  if (/生气|愤怒|不耐烦|angry|mad|cross/.test(raw)) return 'angry';
  return '';
}

/**
 * Drop markup that must not be read out loud.
 *
 * @param {string} text Raw text.
 * @returns {string} Plain text.
 */
function stripMarkup(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)、]\s*/gm, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\r\n?/g, '\n');
}

/**
 * Break one long sentence into breath-sized pieces.
 *
 * Anything past roughly two dozen characters is where a listener loses the
 * thread, so a comma is inserted at a natural boundary — a particle already in
 * the sentence, never between two digits that belong together.
 *
 * @param {string} sentence One sentence without its final punctuation.
 * @returns {string} The sentence, possibly with extra commas.
 */
function breathe(sentence) {
  let rest = sentence.trim();
  const parts = [];
  while (rest.length > 26) {
    let cut = -1;
    for (let index = 12; index < Math.min(rest.length, 26); index += 1) {
      const char = rest[index];
      const next = rest[index + 1] ?? '';
      if (char === '，' || char === '、') cut = index + 1;
      else if ('的了着呢吗嘛吧'.includes(char) && !'0123456789'.includes(next)) cut = index + 1;
    }
    if (cut <= 0) {
      // No particle to lean on: cut at the last point that is not inside a word
      // or a number, so "5070" and "G显存" stay in one piece.
      for (let index = Math.min(rest.length - 1, 26); index >= 12; index -= 1) {
        const char = rest[index];
        const next = rest[index + 1] ?? '';
        if (/[0-9A-Za-z]/.test(char) || /[0-9A-Za-z]/.test(next)) continue;
        cut = index;
        break;
      }
    }
    if (cut <= 0) break;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts.join('，').replace(/，{2,}/g, '，');
}

/**
 * Rewrite a written line for the ear.
 *
 * @param {string} text Raw text, possibly Markdown.
 * @param {{ tone?: string }} [options] Optional hint about the delivery.
 * @returns {string} Speakable text; empty when nothing readable is left.
 */
export function speechify(text, options = {}) {
  const flat = stripMarkup(String(text ?? ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '，')
    .replace(/[：；]/g, '，')
    .replace(/…{2,}|\.{3,}/g, '…')
    .replace(/，{2,}/g, '，')
    .replace(/^[，。！？、\s]+/, '')
    .trim();
  if (flat === '') return '';

  const sentences = [];
  const pattern = /[^。！？!?]+[。！？!?]?/g;
  for (const match of flat.matchAll(pattern)) {
    const piece = match[0].trim();
    if (piece !== '') sentences.push(piece);
  }

  const shaped = sentences.map((sentence) => {
    const closer = /[。！？!?]$/.exec(sentence)?.[0] ?? '';
    const body = closer === '' ? sentence : sentence.slice(0, -1);
    const trimmed = body.replace(/[，、]{2,}/g, '，').replace(/^[，、]+|[，、]+$/g, '');
    return breathe(trimmed) + (closer || '。');
  });

  let out = shaped.join('');
  const tone = normalizeTone(options?.tone);
  const closer = TONE_CLOSERS[tone];
  if (closer !== undefined && out !== '') {
    // Only the last sentence changes: a paragraph of exclamation marks is
    // shouting, and a paragraph of ellipses is a funeral.
    out = out.replace(/[。！？!?…]$/, '') + closer;
  }
  return out;
}

export { normalizeTone };
