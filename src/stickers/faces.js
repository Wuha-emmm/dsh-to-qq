/**
 * QQ's built-in faces (小黄脸).
 *
 * Unlike 收藏表情 these need no library, no download and no id lookup on the
 * wire: a `face` segment with an integer id is enough. They are also the most
 * natural thing to send when a sticker library is still empty, so the bridge
 * offers a small curated list to the model.
 */

/**
 * Curated faces: id, name used by the model, and when it reads well.
 *
 * Only widely known ids are listed; any other numeric id still works when the
 * caller passes it directly.
 *
 * @type {ReadonlyArray<{ id: number, name: string, use: string }>}
 */
export const QQ_FACES = [
  { id: 14, name: '微笑', use: '礼貌、平静' },
  { id: 13, name: '呲牙', use: '得意、开心' },
  { id: 20, name: '偷笑', use: '憋笑、幸灾乐祸' },
  { id: 12, name: '调皮', use: '开玩笑' },
  { id: 4, name: '得意', use: '炫耀、稳了' },
  { id: 6, name: '害羞', use: '被夸、不好意思' },
  { id: 5, name: '流泪', use: '难过、感动' },
  { id: 9, name: '大哭', use: '崩溃、夸张地哭' },
  { id: 22, name: '白眼', use: '无语' },
  { id: 98, name: '抠鼻', use: '不屑、轻松' },
  { id: 99, name: '鼓掌', use: '赞同、捧场' },
  { id: 136, name: '强', use: '点赞、认可' },
  { id: 140, name: '抱拳', use: '承让、感谢' },
  { id: 123, name: '爱心', use: '表达喜欢' },
  { id: 120, name: '玫瑰', use: '致意、感谢' },
  { id: 32, name: '疑问', use: '没听懂' },
  { id: 33, name: '嘘', use: '保密、安静' },
  { id: 34, name: '晕', use: '被绕晕' },
  { id: 36, name: '衰', use: '倒霉' },
  { id: 39, name: '再见', use: '收尾、离开' },
  { id: 135, name: '拥抱', use: '安慰' },
  { id: 109, name: '亲亲', use: '亲近' },
  { id: 101, name: '坏笑', use: '促狭' },
  { id: 106, name: '委屈', use: '被冤枉' },
  { id: 107, name: '快哭了', use: '可怜巴巴' },
  { id: 111, name: '可怜', use: '求饶' },
  { id: 179, name: '狗头', use: '反讽、保命' },
];

/**
 * Render the compact face list for the prompt.
 *
 * @returns {string} One line, or '' when the list is empty.
 */
export function renderFaceList() {
  if (QQ_FACES.length === 0) return '';
  const parts = QQ_FACES.map(face => `${face.name}${face.id}`);
  return `QQ 自带表情（emoji_send，用名字或 id）：${parts.join(' ')}`;
}

/**
 * Find one face by name, id, or a loose description.
 *
 * @param {string} query Name (微笑), numeric id (14), or a use keyword (无语).
 * @returns {{ id: number, name: string, use: string } | undefined} The face.
 */
export function findFace(query) {
  const raw = String(query ?? '').trim();
  if (raw === '') return undefined;
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric >= 0) {
    return QQ_FACES.find(face => face.id === numeric) ?? { id: numeric, name: raw, use: '' };
  }
  const byName = QQ_FACES.find(face => face.name === raw);
  if (byName !== undefined) return byName;
  const byUse = QQ_FACES.filter(face => face.use.includes(raw) || face.name.includes(raw));
  return byUse.length > 0 ? byUse[0] : undefined;
}
