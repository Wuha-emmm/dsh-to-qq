/**
 * Friend and group join requests.
 *
 * OneBot reports these as `post_type: request` (and some backends as a
 * `notice`), with an opaque `flag` that must be echoed back to approve or
 * reject. The bridge never decides by itself: it forwards the request to the
 * administrators and applies their answer.
 */

/**
 * Decode one friend/group request event.
 *
 * @param {any} event Raw OneBot event.
 * @returns {{ kind: 'friend' | 'group-add' | 'group-invite', flag: string, userId: number, nickname: string, groupId: number, comment: string } | undefined} The request.
 */
export function normalizeRequestEvent(event) {
  if (event === null || typeof event !== 'object') return undefined;
  if (event.post_type !== 'request' && event.post_type !== 'notice') return undefined;

  const userId = Number(event.user_id ?? event.sender_id ?? 0);
  const nickname = String(event.nickname ?? event.sender?.nickname ?? '');
  const comment = String(event.comment ?? event.message ?? '');
  const groupId = Number(event.group_id ?? 0);

  if (event.post_type === 'request' && event.request_type === 'friend') {
    const flag = String(event.flag ?? '');
    if (flag === '') return undefined;
    return { kind: 'friend', flag, userId, nickname, groupId: 0, comment };
  }

  if (event.post_type === 'request' && event.request_type === 'group') {
    const flag = String(event.flag ?? '');
    if (flag === '') return undefined;
    const invite = event.sub_type === 'invite';
    return { kind: invite ? 'group-invite' : 'group-add', flag, userId, nickname, groupId, comment };
  }

  // Some backends deliver a group invitation as a notice instead of a request.
  if (event.post_type === 'notice' && event.notice_type === 'group_invite') {
    const flag = String(event.flag ?? event.request_flag ?? '');
    if (flag === '') return undefined;
    return { kind: 'group-invite', flag, userId, nickname, groupId, comment };
  }

  return undefined;
}

/**
 * One-line description used in the administrator's notification.
 *
 * @param {{ kind: string, userId: number, nickname: string, groupId: number, comment: string }} request The request.
 * @param {number} token Short handle shown to the administrator.
 * @returns {string} Notification text.
 */
export function describeRequest(request, token) {
  const who = request.nickname === '' ? String(request.userId) : `${request.nickname}(${request.userId})`;
  const titles = {
    friend: '好友申请',
    'group-add': '入群申请',
    'group-invite': '邀请进群',
  };
  const lines = [`【${titles[request.kind] ?? '申请'} #${token}】${who}`];
  if (request.groupId > 0) lines.push(`群：${request.groupId}`);
  if (request.comment !== '') lines.push(`附言：${request.comment.slice(0, 120)}`);
  lines.push(`回复 /同意 ${token} 或 /拒绝 ${token}（30 分钟内有效）`);
  return lines.join('\n');
}
