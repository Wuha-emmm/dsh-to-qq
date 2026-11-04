/**
 * Best-effort SnowLuma launcher.
 *
 * SnowLuma injects into the already-running QQ client, so it must live as long
 * as DSH does. Starting it from a scheduled task kept the process alive but the
 * console window followed it around; starting it from the bridge keeps it
 * hidden and lets every DSH start heal a dead instance.
 */

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

/**
 * Check whether the OneBot HTTP endpoint answers.
 *
 * A busy instance can miss a single probe (it is injecting into QQ while the
 * request lands), so the caller retries instead of spawning a second copy the
 * moment one probe times out.
 *
 * @param {string} httpUrl Base URL such as `http://127.0.0.1:3000/`.
 * @param {number} [timeoutMs] How long a single probe may take.
 * @returns {Promise<boolean>} True when something answered.
 */
async function reachable(httpUrl, timeoutMs = 1500) {
  const base = httpUrl.endsWith('/') ? httpUrl : `${httpUrl}/`;
  try {
    const response = await fetch(new URL('get_status', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Check whether something already listens on the OneBot websocket port.
 *
 * SnowLuma binds it before it starts answering HTTP, so an open port proves an
 * instance is alive even when `get_status` is still warming up.
 *
 * @param {string} wsUrl Configured websocket URL.
 * @returns {Promise<boolean>} True when the port accepts a connection.
 */
async function portOpen(wsUrl) {
  let host = '127.0.0.1';
  let port = 3001;
  try {
    const parsed = new URL(wsUrl);
    host = parsed.hostname;
    port = Number(parsed.port) || 3001;
  } catch {
    return false;
  }
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const done = value => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Start SnowLuma when it is not answering yet.
 *
 * Runs detached with no console, and appends to the same log files the manual
 * launcher used so diagnostics stay in one place.
 *
 * @param {object} options Launch options.
 * @param {import('../config/defaults.js').QQConfig} options.config Live configuration.
 * @param {(line: string) => void} options.log Diagnostic sink.
 * @returns {Promise<boolean>} True when an instance is answering afterwards.
 */
export async function ensureSnowLuma(options) {
  const { config, log } = options;
  if (config.connection.autoStart !== true) return reachable(config.connection.httpUrl);
  // Three slow probes, because a single timeout used to start a second copy that
  // then fought the first one over ports 3001 and 5099.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await reachable(config.connection.httpUrl, 3000)) return true;
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700));
  }

  // A live websocket port means an instance is up but still warming its HTTP side.
  if (await portOpen(config.connection.wsUrl)) {
    log('SnowLuma port already open; waiting for its HTTP endpoint instead of starting another copy');
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (await reachable(config.connection.httpUrl, 3000)) return true;
    }
    log('SnowLuma port is open but it never answered; leaving the running copy alone');
    return true;
  }

  const dir = config.connection.snowlumaDir;
  if (dir === '') {
    log('SnowLuma is not running and connection.snowlumaDir is empty');
    return false;
  }

  try {
    const out = openSync(join(dir, 'run.out.log'), 'a');
    const err = openSync(join(dir, 'run.err.log'), 'a');
    // No `detached`: libuv maps DETACHED_PROCESS to a brand-new console, which
    // Windows Terminal then shows as a tab. `windowsHide` alone is CREATE_NO_WINDOW.
    // The child dies with DSH, and the next start respawns it.
    const child = spawn(join(dir, 'node.exe'), [join(dir, 'index.mjs')], {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', out, err],
    });
    child.unref();
    log(`started SnowLuma from ${dir} (pid ${child.pid})`);
  } catch (error) {
    log(`SnowLuma auto-start failed: ${error?.message ?? error}`);
    return false;
  }

  // Injection and the OneBot listeners come up within a couple of seconds.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (await reachable(config.connection.httpUrl)) return true;
  }
  log('SnowLuma started but still not answering');
  return false;
}
