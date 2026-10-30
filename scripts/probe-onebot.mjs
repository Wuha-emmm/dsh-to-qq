/**
 * Development probe for a local SnowLuma / OneBot v11 instance.
 *
 * Reads the access token straight from SnowLuma's own account config, then
 * checks the two channels the bridge depends on: the HTTP action endpoint and
 * the WebSocket event stream (including which path it actually listens on).
 *
 * Usage:
 *   node scripts/probe-onebot.mjs [--snowluma D:\SnowLuma] [--uin 10002] [--seconds 8]
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Parse `--name value` pairs.
 *
 * @param {string[]} argv Process arguments after the script name.
 * @returns {Record<string, string>} Parsed options.
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = 'true';
    }
  }
  return options;
}

/**
 * Resolve the account UIN, either from the argument or from SnowLuma's config files.
 *
 * @param {string} snowlumaDir SnowLuma installation directory.
 * @param {string | undefined} explicit UIN passed on the command line.
 * @returns {Promise<string>} The account UIN.
 */
async function resolveUin(snowlumaDir, explicit) {
  if (explicit !== undefined) return explicit;
  const entries = await readdir(join(snowlumaDir, 'config'));
  const account = entries.find(name => /^onebot_\d+\.json$/.test(name));
  if (account === undefined) throw new Error(`no onebot_<uin>.json in ${join(snowlumaDir, 'config')}`);
  return account.replace(/^onebot_/, '').replace(/\.json$/, '');
}

/**
 * Connect to one WebSocket URL and collect frames for a bounded time.
 *
 * @param {URL} url Event endpoint.
 * @param {number} seconds Seconds to listen.
 * @returns {Promise<object[]>} Decoded frames.
 */
function collect(url, seconds) {
  return new Promise(resolve => {
    /** @type {object[]} */
    const frames = [];
    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      resolve(frames);
      return;
    }
    const timer = setTimeout(() => {
      socket.close();
      resolve(frames);
    }, seconds * 1000);
    socket.addEventListener('message', message => {
      try {
        frames.push(JSON.parse(String(message.data)));
      } catch {
        // A malformed frame is not fatal for a probe.
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(frames);
    });
  });
}

const args = parseArgs(process.argv.slice(2));
const snowlumaDir = args.snowluma ?? 'D:\\SnowLuma';
const seconds = Number(args.seconds ?? 8);
const uin = await resolveUin(snowlumaDir, args.uin);
const configFile = join(snowlumaDir, 'config', `onebot_${uin}.json`);

const config = JSON.parse(await readFile(configFile, 'utf8'));
const http = config.networks.httpServers[0];
const ws = config.networks.wsServers[0];
const token = http.accessToken;
const httpBase = `http://${http.host}:${http.port}${http.path.endsWith('/') ? http.path : `${http.path}/`}`;

console.log(`config      ${configFile}`);
console.log(`http        ${httpBase}`);
console.log(`ws          ws://${ws.host}:${ws.port}${ws.path}`);
console.log(`token       http=${http.accessToken === '' ? 'none' : `${http.accessToken.length}c`} ws=${ws.accessToken === '' ? 'none' : `${ws.accessToken.length}c`}`);

const response = await fetch(new URL('get_login_info', httpBase), {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: '{}',
  signal: AbortSignal.timeout(10_000),
});
const envelope = await response.json();
console.log(`http        retcode=${envelope.retcode} login=${envelope.data?.user_id} (${envelope.data?.nickname})`);

for (const path of [ws.path, '/event']) {
  const url = new URL(path, `ws://${ws.host}:${ws.port}/`);
  if (ws.accessToken !== '') url.searchParams.set('access_token', ws.accessToken);
  const frames = await collect(url, seconds);
  const kinds = frames.slice(0, 3).map(frame => frame.post_type ?? frame.meta_event_type ?? '?').join(',');
  console.log(`ws ${path.padEnd(8)} frames=${frames.length} first=${kinds}`);
}

