/**
 * Detecting "stop sending stickers" and "you can send stickers again".
 *
 * The model decides when a sticker fits, but a person who says they do not want
 * them should not have to argue with a model. These patterns mute one
 * conversation; the bridge still lets the model talk, just without stickers.
 */

/** Phrases that clearly mean "no stickers here". */
const MUTE_PATTERNS = [
  /(别|不要|不用|不许|少|停止|拒绝)(再)?(发|来|刷|用)(表情包?|贴纸|图)/,
  /(表情包?|贴纸)(别|不要|不用|免了)/,
  /别发表情/,
];

/** Phrases that clearly mean "stickers are fine again". */
const UNMUTE_PATTERNS = [
  /(可以|能|允许|欢迎|尽管)(再)?(发|来|用)(表情包?|贴纸)/,
  /表情包?(可以|没问题|随便|尽管)/,
  /发表情(吧|呀|啊|嘛)/,
];

/**
 * Decide whether a message turns stickers off for its conversation.
 *
 * @param {string} text Message text.
 * @returns {boolean} True when the message asks for no stickers.
 */
export function wantsNoStickers(text) {
  const body = String(text ?? '');
  if (body === '') return false;
  return MUTE_PATTERNS.some(pattern => pattern.test(body));
}

/**
 * Decide whether a message turns stickers back on.
 *
 * @param {string} text Message text.
 * @returns {boolean} True when the message allows stickers again.
 */
export function wantsStickers(text) {
  const body = String(text ?? '');
  if (body === '') return false;
  return UNMUTE_PATTERNS.some(pattern => pattern.test(body));
}
