/**
 * OneBot v11 transport.
 *
 * Events arrive over one WebSocket; actions go out over HTTP. Keeping the two
 * directions separate removes the `echo` bookkeeping a universal socket needs,
 * and a dropped socket never blocks an outgoing reply.
 */

/** Sentinel for a caller that never set a timeout. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Raised when OneBot answers HTTP 200 with a non-zero `retcode`. */
export class OneBotError extends Error {
  /**
   * @param {string} action The action that failed.
   * @param {{ retcode?: number, message?: string, wording?: string }} envelope The reply envelope.
   */
  constructor(action, envelope) {
    super(`OneBot ${action} failed (retcode ${envelope.retcode ?? 'unknown'}): ${envelope.wording || envelope.message || 'no detail'}`);
    this.name = 'OneBotError';
    this.action = action;
    this.retcode = envelope.retcode;
  }
}

/**
 * A reconnecting OneBot v11 client.
 *
 * @typedef {'idle' | 'connecting' | 'online' | 'backoff' | 'stopped'} TransportState
 */
export class OneBotClient {
  /**
   * @param {object} options Client options.
   * @param {string} options.httpUrl Action endpoint, such as `http://127.0.0.1:3000/`.
   * @param {string} options.wsUrl Event endpoint, such as `ws://127.0.0.1:3001`.
   * @param {string} [options.eventPath] Path appended to `wsUrl`.
   * @param {string} [options.token] OneBot access token for the WebSocket.
   * @param {string} [options.httpToken] Access token for HTTP actions; falls back to `token`.
   * @param {{ enabled?: boolean, baseMs?: number, maxMs?: number }} [options.reconnect] Backoff policy.
   * @param {(event: any) => void} [options.onEvent] Receives every decoded event.
   * @param {(state: TransportState, detail?: string) => void} [options.onState] State transitions.
   * @param {(error: Error) => void} [options.onError] Ignored failures such as a malformed frame.
   */
  constructor(options) {
    this.httpUrl = options.httpUrl;
    this.wsUrl = options.wsUrl;
    this.eventPath = options.eventPath ?? '/';
    this.token = options.token ?? '';
    this.httpToken = options.httpToken ?? this.token;
    this.reconnect = { enabled: true, baseMs: 1000, maxMs: 30_000, ...options.reconnect };
    this.onEvent = options.onEvent ?? (() => {});
    this.onState = options.onState ?? (() => {});
    this.onError = options.onError ?? (() => {});

    /** @type {TransportState} */
    this.state = 'idle';
    /** @type {WebSocket | undefined} */
    this.socket = undefined;
    this.attempt = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.retryTimer = undefined;
    this.stopped = true;
  }

  /** Open the event stream and keep it open until `stop()`. */
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#connect();
  }

  /** Close the stream and cancel any pending reconnect. */
  stop() {
    this.stopped = true;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    this.#setState('stopped');
  }

  /**
   * Invoke one OneBot action over HTTP.
   *
   * @template T
   * @param {string} action Action name, such as `send_private_msg`.
   * @param {Record<string, unknown>} [params] Action parameters.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] Call limits.
   * @returns {Promise<T>} The envelope's `data`.
   */
  async call(action, params = {}, options = {}) {
    const base = this.httpUrl.endsWith('/') ? this.httpUrl : `${this.httpUrl}/`;
    const url = new URL(action.replace(/^\//, ''), base);
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)])
      : AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const headers = { 'content-type': 'application/json' };
    if (this.httpToken !== '') headers.authorization = `Bearer ${this.httpToken}`;

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(params), signal });
    if (!response.ok) throw new Error(`OneBot ${action} HTTP ${response.status}`);
    const envelope = await response.json();
    if (envelope === null || typeof envelope !== 'object') throw new Error(`OneBot ${action} returned a non-object envelope`);
    if (envelope.retcode !== 0) throw new OneBotError(action, envelope);
    return envelope.data;
  }

  /** Open one WebSocket and wire its lifecycle. */
  #connect() {
    this.#setState('connecting');
    const url = this.#eventUrl();
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.#setState('online');
    });
    socket.addEventListener('message', message => {
      try {
        const event = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data));
        if (event !== null && typeof event === 'object') this.onEvent(event);
      } catch (error) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener('error', () => {
      // The close event carries the actionable signal; surface it there only.
    });
    socket.addEventListener('close', () => {
      this.socket = undefined;
      if (this.stopped) return;
      this.#setState('backoff', 'connection closed');
      this.#scheduleReconnect();
    });
  }

  /**
   * Build the event WebSocket URL, appending the token as a query parameter
   * because a browser-style WebSocket cannot set an Authorization header.
   *
   * @returns {string} The complete URL.
   */
  #eventUrl() {
    const base = new URL(this.eventPath || '/', this.wsUrl.endsWith('/') ? this.wsUrl : `${this.wsUrl}/`);
    if (this.token !== '') base.searchParams.set('access_token', this.token);
    return base.toString();
  }

  /** Schedule the next connection attempt with exponential backoff and jitter. */
  #scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnect.enabled === false) {
      this.#setState('stopped', 'reconnect disabled');
      return;
    }
    const exponential = Math.min(this.reconnect.maxMs, this.reconnect.baseMs * 2 ** this.attempt);
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped) this.#connect();
    }, delay);
  }

  /**
   * Record and publish a state transition.
   *
   * @param {TransportState} state The new state.
   * @param {string} [detail] Human-readable context.
   */
  #setState(state, detail) {
    this.state = state;
    this.onState(state, detail);
  }
}
