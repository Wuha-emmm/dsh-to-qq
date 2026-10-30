/**
 * Access rules for the panel's HTTP API.
 *
 * The endpoints expose configuration (and can rewrite it), so they must not be
 * reachable from a browser page on another origin: DNS rebinding or a stray
 * link would otherwise be enough to reconfigure the bridge.
 */

/** Loopback addresses as Node reports them. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Decide whether a request may touch the panel API.
 *
 * Two conditions, both cheap:
 * 1. The TCP peer is loopback — the panel is a local surface, not a service.
 * 2. When the browser sends `Origin`, it matches the request host, so a page on
 *    another site cannot drive the API through the user's browser.
 *
 * Requests without an `Origin` header (curl, tests) are allowed when they come
 * from loopback.
 *
 * @param {{ remoteAddress?: string, origin?: string, host?: string }} request Request facts.
 * @returns {{ allowed: boolean, reason: string }} Verdict plus a short reason for logs.
 */
export function panelAccess(request) {
  const remote = String(request?.remoteAddress ?? '');
  if (!LOOPBACK.has(remote)) return { allowed: false, reason: `non-loopback peer ${remote === '' ? '(unknown)' : remote}` };

  const origin = String(request?.origin ?? '');
  if (origin === '') return { allowed: true, reason: 'loopback' };
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    return { allowed: false, reason: `malformed origin ${origin}` };
  }
  const host = String(request?.host ?? '');
  if (host === '' || originHost === host) return { allowed: true, reason: 'same origin' };
  return { allowed: false, reason: `cross-origin ${originHost} -> ${host}` };
}
