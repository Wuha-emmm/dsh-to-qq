/**
 * Merged forward chats.
 *
 * OneBot delivers a merged forward as a `forward` segment carrying only an id;
 * the content lives behind `get_forward_msg`. Without fetching it the bridge
 * sees "[聊天记录]" and the model learns nothing, which is why forwarded logs
 * looked unreadable.
 */

/** How many forwarded messages to include. */
const MAX_MESSAGES = 40;

/** How many characters the flattened transcript may occupy. */
const MAX_CHARS = 4000;

/** How many rendered lines one transcript may contain, nesting included. */
const MAX_LINES = 60;

/** How many images a single forward may contribute. */
const MAX_IMAGES = 4;

/**
 * Pick the forward segments of one message.
 *
 * @param {ReadonlyArray<{ type: string, data?: Record<string, unknown> }>} segments Message segments.
 * @returns {Array<{ type: string, data?: Record<string, unknown> }>} Forward segments.
 */
export function forwardSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.filter(segment => segment?.type === 'forward' && typeof segment?.data?.id === 'string');
}

/**
 * Flatten a `get_forward_msg` result into readable text.
 *
 * @param {any} payload Action response: `{ messages: [...] }` or `{ data: { messages } }`.
 * @param {{ maxMessages?: number, maxChars?: number }} [options] Limits.
 * @returns {string} Transcript, or an empty string when nothing usable arrived.
 */
export function formatForward(payload, options = {}) {
  const maxMessages = options.maxMessages ?? MAX_MESSAGES;
  const maxChars = options.maxChars ?? MAX_CHARS;
  const messages = Array.isArray(payload?.messages)
    ? payload.messages
    : Array.isArray(payload?.data?.messages) ? payload.data.messages : [];
  if (messages.length === 0) return '';

  const lines = [`【合并转发 · ${messages.length} 条】`];
  let used = lines[0].length;
  for (const node of messages.slice(0, maxMessages)) {
    const sender = node?.sender?.card || node?.sender?.nickname || node?.nickname || String(node?.user_id ?? '某人');
    const content = Array.isArray(node?.message)
      ? node.message.map(segment => segment?.data?.text ?? segment?.data?.summary ?? '').join('')
      : (typeof node?.content === 'string' ? node.content : Array.isArray(node?.content)
        ? node.content.map(part => part?.data?.text ?? part?.text ?? '').join('')
        : '');
    const text = String(content ?? '').replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const line = `[${sender}] ${text.slice(0, 200)}`;
    if (used + line.length > maxChars) {
      lines.push('…（内容过长，已截断）');
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length === 1 ? '' : lines.join('\n');
}

/** How deep nested forwards are expanded: the top level plus one inner layer. */
const MAX_DEPTH = 2;

/**
 * Normalize one `get_forward_msg` response into a message array.
 *
 * @param {any} payload Action response.
 * @returns {any[]} Nodes.
 */
function nodesOf(payload) {
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (Array.isArray(payload?.data?.messages)) return payload.data.messages;
  return [];
}

/**
 * Text of one node, ignoring nested forwards (they are expanded separately).
 *
 * @param {any} node Forwarded message node.
 * @returns {string} Flattened text.
 */
function nodeText(node) {
  if (Array.isArray(node?.message)) {
    return node.message
      .map(segment => (segment?.type === 'text' ? segment?.data?.text ?? '' : segment?.data?.summary ?? ''))
      .join('');
  }
  if (typeof node?.content === 'string') return node.content;
  if (Array.isArray(node?.content)) return node.content.map(part => part?.data?.text ?? part?.text ?? '').join('');
  return '';
}

/**
 * Node name, preferring the group card.
 *
 * @param {any} node Forwarded message node.
 * @returns {string} Display name.
 */
function nodeSender(node) {
  return node?.sender?.card || node?.sender?.nickname || node?.nickname || String(node?.user_id ?? '某人');
}

/**
 * Expand one forward, recursively fetching any forward nested inside it.
 *
 * @param {{ call: (action: string, params: object, options?: object) => Promise<any> } | undefined} client OneBot client.
 * @param {any} payload `get_forward_msg` response.
 * @param {object} state Shared budget.
 * @param {number} state.depth Current depth (1 = top level).
 * @param {{ chars: number }} state.budget Consumed characters.
 * @param {number} state.lines Consumed lines.
 * @param {Array<object>} state.images Image segments seen inside the forward.
 * @param {(line: string) => void} log Diagnostic sink.
 * @returns {Promise<string[]>} Rendered lines, already indented.
 */
async function expandNodes(client, payload, state, log) {
  const nodes = nodesOf(payload);
  if (nodes.length === 0) return [];
  const indent = '  '.repeat(Math.max(0, state.depth - 1));
  const lines = state.depth === 1 ? [`【合并转发 · ${nodes.length} 条】`] : [`${indent}【嵌套转发 · ${nodes.length} 条】`];

  for (const node of nodes) {
    if (state.lines >= MAX_LINES) {
      lines.push(`${indent}…（条数过多，已截断）`);
      break;
    }
    const depthLeft = state.depth < MAX_DEPTH && client !== undefined;

    // Images inside a forward become real pictures later; collect their
    // segments here so the caller can download them like any other image.
    if (Array.isArray(node?.message)) {
      for (const segment of node.message) {
        if (segment?.type !== 'image') continue;
        if (typeof segment.data?.url !== 'string' && typeof segment.data?.file === 'string' && client !== undefined) {
          try {
            const info = await client.call('get_image', { file: segment.data.file }, { timeoutMs: 8000 });
            const url = info?.url ?? info?.data?.url ?? info?.file;
            if (typeof url === 'string' && url !== '') segment.data = { ...segment.data, url };
          } catch {
            // keep the placeholder text
          }
        }
        if (typeof segment?.data?.url !== 'string' || segment.data.url === '') continue;
        if (state.images.length >= MAX_IMAGES) break;
        state.images.push({ type: 'image', data: segment.data });
      }

    // A nested forward inside this node: expand it one level down.
    const nested = Array.isArray(node?.message)
      ? node.message.filter(segment => segment?.type === 'forward' && typeof segment?.data?.id === 'string')
      : [];
    if (nested.length > 0 && depthLeft) {
      const name = nodeSender(node);
      lines.push(`${indent}[${name}] 转发了一段聊天记录：`);
      state.lines += 1;
      for (const segment of nested) {
        try {
          const inner = await client.call('get_forward_msg', { id: String(segment.data.id) }, { timeoutMs: 15_000 });
          state.depth += 1;
          const innerLines = await expandNodes(client, inner, state, log);
          state.depth -= 1;
          for (const line of innerLines) {
            if (state.budget.chars + line.length > MAX_CHARS) {
              lines.push(`${indent}  …（内容过长，已截断）`);
              break;
            }
            lines.push(line);
            state.budget.chars += line.length + 1;
            state.lines += 1;
          }
        } catch (error) {
          log(`nested forward fetch failed: ${error?.message ?? error}`);
        }
      }
      continue;
    }

    }

    const text = nodeText(node).replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const line = `${indent}[${nodeSender(node)}] ${text.slice(0, 200)}`;
    if (state.budget.chars + line.length > MAX_CHARS) {
      lines.push(`${indent}…（内容过长，已截断）`);
      break;
    }
    lines.push(line);
    state.budget.chars += line.length + 1;
    state.lines += 1;
  }
  return lines;
}

/**
 * Expand one forward payload into text, following nested forwards.
 *
 * @param {{ call: (action: string, params: object, options?: object) => Promise<any> } | undefined} client OneBot client.
 * @param {any} payload `get_forward_msg` response.
 * @param {(line: string) => void} log Diagnostic sink.
 * @returns {Promise<string>} Rendered transcript.
 */
export async function expandForward(client, payload, log = () => {}) {
  const state = { depth: 1, budget: { chars: 0 }, lines: 0, images: [] };
  const lines = await expandNodes(client, payload, state, log);
  return { text: lines.length === 0 ? '' : lines.join('\n'), images: state.images };
}

/**
 * Fetch and flatten every merged forward in one message.
 *
 * @param {{ call: (action: string, params: object, options?: object) => Promise<any> } | undefined} client OneBot client.
 * @param {ReadonlyArray<{ type: string, data?: Record<string, unknown> }>} segments Message segments.
 * @param {(line: string) => void} log Diagnostic sink.
 * @returns {Promise<string>} Concatenated transcripts, or an empty string.
 */
export async function fetchForwards(client, segments, log) {
  const forwards = forwardSegments(segments);
  if (forwards.length === 0 || client === undefined) return { text: '', images: [] };
  const blocks = [];
  const images = [];
  for (const segment of forwards) {
    const id = String(segment.data?.id);
    try {
      const payload = await client.call('get_forward_msg', { id }, { timeoutMs: 15_000 });
      const expanded = await expandForward(client, payload, log);
      if (expanded.text !== '') blocks.push(expanded.text);
      for (const image of expanded.images) {
        if (images.length >= MAX_IMAGES) break;
        images.push(image);
      }
    } catch (error) {
      log(`forward fetch failed: ${error?.message ?? error}`);
    }
  }
  return { text: blocks.join('\n\n'), images };
}





