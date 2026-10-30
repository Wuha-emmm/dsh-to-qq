/**
 * OneBot v11 event decoding.
 *
 * Everything the bridge needs from a raw event is reduced here to one plain
 * record, so policy, context, and archive code never touch wire shapes.
 */

/** Segment type to placeholder used when flattening a message into text. */
const SEGMENT_LABELS = {
  image: '[图片]',
  face: '[表情]',
  mface: '[动画表情]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  forward: '[聊天记录]',
  json: '[卡片]',
  xml: '[卡片]',
  poke: '[戳一戳]',
  dice: '[骰子]',
  rps: '[猜拳]',
  markdown: '[富文本]',
  node: '[聊天记录]',
};

/**
 * @typedef {object} QQMessage
 * @property {string} key Unique dedupe key.
 * @property {'dm' | 'group'} kind Scene kind.
 * @property {string} scene Scene key, such as `dm:10001` or `group:20001`.
 * @property {number} selfId The bot account that received it.
 * @property {number} senderId Sender QQ number.
 * @property {string} senderName Display name, preferring the group card.
 * @property {string} text Flattened text with placeholders.
 * @property {number} messageId OneBot message id.
 * @property {number} time Unix seconds.
 * @property {boolean} mentionsBot Whether the bot was @-mentioned.
 * @property {boolean} mentionsAll Whether @all was used.
 * @property {string | undefined} replyTo Quoted message id.
 * @property {boolean} anonymous Whether the group message was anonymous.
 * @property {ReadonlyArray<{ type: string, data: Record<string, unknown> }>} segments Raw segments.
 */

/**
 * Flatten OneBot message segments into text.
 *
 * @param {ReadonlyArray<{ type: string, data?: Record<string, unknown> }>} segments Raw segments.
 * @param {number} selfId The bot account, used to render self mentions.
 * @returns {{ text: string, mentionsBot: boolean, mentionsAll: boolean, replyTo: string | undefined }}
 *   Flattened text and mention facts.
 */
export function flattenSegments(segments, selfId) {
  let text = '';
  let mentionsBot = false;
  let mentionsAll = false;
  let replyTo;
  for (const segment of segments ?? []) {
    if (segment === null || typeof segment !== 'object') continue;
    const data = segment.data ?? {};
    if (segment.type === 'text') {
      text += typeof data.text === 'string' ? data.text : '';
      continue;
    }
    if (segment.type === 'at') {
      const target = String(data.qq ?? '');
      if (target === String(selfId)) mentionsBot = true;
      if (target === 'all') mentionsAll = true;
      text += target === 'all' ? '@全体成员' : `@${typeof data.name === 'string' && data.name !== '' ? data.name : target}`;
      continue;
    }
    if (segment.type === 'reply') {
      if (data.id !== undefined && data.id !== null) replyTo = String(data.id);
      continue;
    }
    text += SEGMENT_LABELS[segment.type] ?? `[${segment.type}]`;
  }
  return { text: text.trim(), mentionsBot, mentionsAll, replyTo };
}

/**
 * Decode one OneBot event into a {@link QQMessage}, or `undefined` when the
 * event is not an inbound chat message (meta events, notices, self echoes).
 *
 * @param {any} event Decoded OneBot event.
 * @returns {QQMessage | undefined} The normalized message.
 */
export function normalizeEvent(event) {
  if (event === null || typeof event !== 'object') return undefined;
  if (event.post_type !== 'message') return undefined;
  if (event.message_type !== 'private' && event.message_type !== 'group') return undefined;
  if (event.message_type === 'private' && event.sub_type === 'self') return undefined;

  const selfId = Number(event.self_id);
  const senderId = Number(event.user_id ?? event.sender?.user_id);
  if (!Number.isInteger(selfId) || !Number.isInteger(senderId)) return undefined;
  if (senderId === selfId) return undefined;

  const messageId = Number(event.message_id);
  const kind = event.message_type === 'private' ? 'dm' : 'group';
  const peerId = kind === 'dm' ? senderId : Number(event.group_id);
  if (!Number.isInteger(peerId)) return undefined;

  const segments = Array.isArray(event.message) ? event.message : [];
  const { text, mentionsBot, mentionsAll, replyTo } = flattenSegments(segments, selfId);
  const senderName = String(
    event.sender?.card || event.sender?.nickname || (kind === 'dm' ? String(senderId) : String(senderId)),
  );

  return {
    key: `${selfId}:${messageId}`,
    kind,
    scene: kind === 'dm' ? `dm:${peerId}` : `group:${peerId}`,
    peerId,
    groupId: kind === 'group' ? peerId : undefined,
    selfId,
    senderId,
    senderName,
    text,
    messageId,
    time: Number(event.time) || Math.floor(Date.now() / 1000),
    mentionsBot,
    mentionsAll,
    replyTo,
    anonymous: event.anonymous !== undefined && event.anonymous !== null,
    segments,
  };
}

/**
 * Split long text into chunks on paragraph boundaries.
 *
 * @param {string} text Text to split.
 * @param {number} [limit] Maximum characters per chunk.
 * @returns {string[]} Chunks, never empty when the input is non-empty.
 */
export function chunkText(text, limit = 1500) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current !== '' && current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current === '' ? line : `${current}\n${line}`;
    }
    while (current.length > limit) {
      chunks.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

