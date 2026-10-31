/**
 * Refuse a shell command that calls the OneBot send API directly.
 *
 * Going around the bridge skips archiving, skips the tier rules, and — as happened
 * twice with SnowLuma — can deliver the same file twice when an upload and a send
 * both push it. `qq_send` is the only supported path.
 */

/** API names that deliver something to a chat. */
export const RAW_SEND_PATTERN = /(send_private_msg|send_group_msg|upload_private_file|upload_group_file)/;

/**
 * Whether a shell command is a raw OneBot send.
 *
 * @param {string} command Shell command line.
 * @returns {boolean} True when it must be refused.
 */
export function isRawSend(command) {
  return RAW_SEND_PATTERN.test(String(command ?? ''));
}

/**
 * Why the command is refused.
 *
 * @param {string} command Shell command line.
 * @returns {string | undefined} Refusal text, or undefined when allowed.
 */
export function rawSendRefusal(command) {
  if (!isRawSend(command)) return undefined;
  return '不要用 pwsh 直接调 OneBot/SnowLuma 的发送接口（绕过桥：不入档案、不受档位限制，还可能把同一个文件发两遍）。发图片或文件请用 qq_send。';
}
