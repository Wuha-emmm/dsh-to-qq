/**
 * Turning sticker descriptions into something the model can choose from.
 *
 * The catalog is a compact text block: code, optional category, one-line note.
 * Only stickers that were recognized (or edited by the owner) appear, so an
 * unread library never shows up as a list of empty lines.
 */

/** How many stickers one prompt block may list. */
const DEFAULT_LIMIT = 24;

/**
 * Stable short handle for one sticker.
 *
 * @param {{ md5: string, code?: string }} sticker Sticker.
 * @returns {string} Code, or an md5 prefix when no code was stored.
 */
export function stickerHandle(sticker) {
  const code = String(sticker?.code ?? '').trim();
  if (code !== '') return code;
  return String(sticker?.md5 ?? '').slice(0, 6);
}

/**
 * Render the catalog block shown to the model.
 *
 * @param {ReadonlyArray<{ md5: string, code?: string, category?: string, desc: string, readAt?: number }>} stickers Library.
 * @param {{ limit?: number, header?: boolean, muted?: boolean }} [options] Rendering options.
 * @returns {string} Prompt text, or '' when there is nothing worth listing.
 */
export function renderStickerBlock(stickers, options = {}) {
  const limit = Math.max(0, options.limit ?? DEFAULT_LIMIT);
  if (options.muted === true) {
    return '【表情包】对方说过不想收表情，本轮不要发。';
  }
  const ready = (Array.isArray(stickers) ? stickers : [])
    .filter(sticker => typeof sticker?.desc === 'string' && sticker.desc.trim() !== '')
    .filter(sticker => sticker.readAt === undefined || sticker.readAt > 0)
    .slice(0, limit);
  if (ready.length === 0) return '';
  const lines = [];
  if (options.header !== false) {
    lines.push('【表情包库】需要时可用 sticker_send 发一个（编号或描述关键词）：');
  }
  for (const sticker of ready) {
    const category = String(sticker.category ?? '').trim();
    const tag = category === '' ? '' : `〔${category}〕`;
    lines.push(`- ${stickerHandle(sticker)}${tag} ${sticker.desc.trim()}`);
  }
  if (options.header !== false) {
    lines.push('只在语境真的合适时发；对方明确表示收/不收，或正在严肃讨论时不要发；一轮最多一个。');
  }
  return lines.join('\n');
}

/**
 * Match free text against codes, categories, and descriptions.
 *
 * @param {ReadonlyArray<{ md5: string, code?: string, category?: string, desc: string }>} stickers Library.
 * @param {string} query Code, keyword, or description fragment.
 * @returns {Array<any>} Best matches, most specific first.
 */
export function findStickers(stickers, query) {
  const raw = String(query ?? '').trim().toLowerCase();
  if (raw === '') return [];
  const list = Array.isArray(stickers) ? stickers : [];
  const byCode = list.filter(sticker => String(stickerHandle(sticker)).toLowerCase() === raw);
  if (byCode.length > 0) return byCode;
  const byText = list.filter(sticker => {
    const haystack = `${sticker.desc ?? ''} ${sticker.category ?? ''}`.toLowerCase();
    return haystack.includes(raw);
  });
  // Longer overlaps are better matches: "鲸鱼娘女仆" beats "表情".
  byText.sort((left, right) => String(right.desc).length - String(left.desc).length);
  return byText;
}
