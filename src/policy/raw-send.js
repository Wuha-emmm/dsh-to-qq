/**
 * Refuse a shell command that calls a OneBot write API directly.
 *
 * Going around the bridge skips archiving, skips the tier rules, and — as happened
 * twice with SnowLuma — can deliver the same file twice when an upload and a send
 * both push it. `qq_send` is the only supported path.
 *
 * This is a guard rail against the model improvising, not a security boundary: a
 * concatenated URL or a script file still gets through, and the token remains
 * readable on disk. It exists to stop the accident, not a determined adversary.
 */

/** API names that write something to a chat. */
const WRITE_ACTIONS = /(send_private_msg|send_group_msg|send_msg|upload_private_file|upload_group_file|set_friend_add_request|set_group_add_request)/;

/** Any OneBot port path that starts with a write verb, even when spelled differently. */
const PORT_WRITE_PATH = /:\d{2,5}\/(send_|upload_|set_)/i;

/**
 * Whether a shell command is a raw OneBot write call.
 *
 * @param {string} command Shell command line.
 * @returns {boolean} True when it must be refused.
 */
export function isRawSend(command) {
  const text = String(command ?? '');
  if (WRITE_ACTIONS.test(text)) return true;
  return PORT_WRITE_PATH.test(text);
}

/**
 * Why the command is refused.
 *
 * @param {string} command Shell command line.
 * @returns {string | undefined} Refusal text, or undefined when allowed.
 */
export function rawSendRefusal(command) {
  if (!isRawSend(command)) return undefined;
  return '不要用 pwsh 直接调 OneBot/SnowLuma 的发送接口（绕过桥：不入档案、不受档位限制，还可能把同一个文件发两遍）。发图片或文件请用 qq_send；读取类接口（get_status 等）不受限制。';
}
