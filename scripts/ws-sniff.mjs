/**
 * Verbose WebSocket sniff for a SnowLuma OneBot endpoint.
 *
 * Prints open / close / error events and every decoded frame, so a silent
 * connection can be told apart from a rejected one.
 *
 * Usage: node scripts/ws-sniff.mjs [--snowluma D:\SnowLuma] [--path /] [--seconds 8]
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, argument, index, all) => {
    if (argument.startsWith('--')) pairs.push([argument.slice(2), all[index + 1]?.startsWith('--') === false ? all[index + 1] : 'true']);
    return pairs;
  }, []),
);

const snowlumaDir = args.snowluma ?? 'D:\\SnowLuma';
const entries = await readdir(join(snowlumaDir, 'config'));
const account = entries.find(name => /^onebot_\d+\.json$/.test(name));
const config = JSON.parse(await readFile(join(snowlumaDir, 'config', account), 'utf8'));
const http = config.networks.httpServers[0];
const ws = config.networks.wsServers[0];
const path = args.path ?? ws.path;
const url = new URL(path, `ws://${ws.host}:${ws.port}/`);
// SnowLuma issues separate tokens for HTTP and WS: use the WS one here.
if (ws.accessToken !== '') url.searchParams.set('access_token', ws.accessToken);

console.log(`connecting ${url.toString().replace(/access_token=[^&]+/, 'access_token=***')}`);
const socket = new WebSocket(url);
const started = Date.now();

socket.addEventListener('open', () => console.log(`+${Date.now() - started}ms open`));
socket.addEventListener('close', event => console.log(`+${Date.now() - started}ms close code=${event.code} reason=${event.reason}`));
socket.addEventListener('error', () => console.log(`+${Date.now() - started}ms error`));
socket.addEventListener('message', message => {
  const text = String(message.data);
  console.log(`+${Date.now() - started}ms message ${text.slice(0, 300)}`);
});

setTimeout(() => {
  socket.close();
  console.log('done');
  process.exit(0);
}, Number(args.seconds ?? 8) * 1000);
