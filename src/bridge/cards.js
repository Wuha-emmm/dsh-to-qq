/**
 * Read a QQ card segment (json/xml) as plain text.
 *
 * QQ turns a shared post, mini-app, music or location into a `json`/`xml`
 * segment. The bridge used to flatten every one of those to a bare `[卡片]`, so
 * the model could not answer anything about it. This module digs out the fields
 * a person actually sees: title, description, source and link.
 */

/**
 * Read the visible text of a json card segment.
 *
 * A card nests its payload under `meta`, one entry per template; that entry
 * holds the real headline, while the outer `desc` is only the category
 * ("新闻", "音乐"). Prefer the nested fields and fall back to the outer ones.
 *
 * @param {string} raw The `data.data` string of a `json` segment.
 * @returns {{ title: string, body: string, source: string, url: string, group: string }} Fields.
 */
function readJsonCard(raw) {
  const empty = { title: '', body: '', source: '', url: '', group: '' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object') return empty;
  const meta = parsed.meta !== null && typeof parsed.meta === 'object'
    ? Object.values(parsed.meta).find(entry => entry !== null && typeof entry === 'object')
    : undefined;
  const node = meta ?? parsed;
  const text = (source, keys) => {
    for (const key of keys) {
      const value = source?.[key];
      if (typeof value === 'string' && value.trim().length > 1) return value.trim();
    }
    return '';
  };
  const title = text(node, ['title', 'prompt']) || text(parsed, ['prompt', 'desc']);
  const body = text(node, ['desc', 'description', 'summary', 'content'])
    || (title === text(parsed, ['desc']) ? '' : text(parsed, ['desc']));
  const source = text(node, ['tag', 'source', 'app_name']) || text(parsed, ['source']);
  // "com.tencent.structmsg" is an implementation id, not something a person reads.
  const visibleSource = source !== '' && !/^[\w.-]+$/.test(source) ? source : '';
  const url = text(node, ['jumpUrl', 'jump_url', 'qqdocurl', 'url']) || text(parsed, ['jumpUrl', 'url']);
  const groupName = text(node, ['group_name', 'groupname', 'invite_group_name']) || text(parsed, ['group_name']);
  const groupCode = text(node, ['group_code', 'groupcode', 'group_id']) || text(parsed, ['group_code', 'group_id']);
  return {
    title,
    body: body === title ? '' : body,
    source: visibleSource,
    url: /^https?:/.test(url) ? url : '',
    group: groupName !== '' || groupCode !== '' ? `${groupName}${groupName !== '' && groupCode !== '' ? '(' : ''}${groupCode}${groupName !== '' && groupCode !== '' ? ')' : ''}` : '',
  };
}

/**
 * Read the visible text of an xml card segment.
 *
 * @param {string} raw The `data.data` string of an `xml` segment.
 * @returns {{ title: string, body: string, source: string, url: string }} Fields.
 */
function readXmlCard(raw) {
  const pick = tag => {
    const match = new RegExp(`<${tag}>([^<]{1,200})</${tag}>`, 'i').exec(raw);
    return match === null ? '' : match[1].trim();
  };
  const url = /(?:url|jumpUrl)="?(https?:\/\/[^"<\s]+)/i.exec(raw)?.[1] ?? '';
  return {
    title: pick('title') || pick('brief'),
    body: pick('summary') || pick('desc'),
    source: pick('source') || pick('appinfo'),
    url,
    group: pick('groupname') || pick('group_name'),
  };
}

/**
 * Turn a card segment into readable text.
 *
 * @param {{ type: string, data?: Record<string, any> }} segment The raw segment.
 * @returns {string} Text for the prompt, or '' when nothing was readable.
 */
export function describeCard(segment) {
  const raw = segment?.data?.data;
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  const fields = segment.type === 'json' ? readJsonCard(raw) : readXmlCard(raw);
  const parts = [];
  const value = fields.title ?? '';
  if (typeof value === 'string' && value !== '') parts.push(value.slice(0, 120));
  const body = typeof fields.body === 'string' ? fields.body : '';
  if (body !== '' && body !== value) parts.push(body.slice(0, 160));
  if (typeof fields.group === 'string' && fields.group !== '') parts.push(`群：${fields.group.slice(0, 60)}`);
  if (typeof fields.source === 'string' && fields.source !== '') parts.push(`来源：${fields.source.slice(0, 40)}`);
  if (typeof fields.url === 'string' && fields.url !== '') parts.push(fields.url.slice(0, 200));
  if (parts.length === 0) return '';
  return `[卡片] ${parts.join(' · ')}`;
}
