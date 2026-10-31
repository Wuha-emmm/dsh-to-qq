/**
 * DSH session driver.
 *
 * One QQ scene maps to one durable DSH session; a prompt is admitted through
 * `ctx.sessionController`, the reply is read from the same follow stream the web
 * client uses, and an idle agent wakes on its own turn.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Wait for a number of milliseconds.
 *
 * @param {number} ms Delay.
 * @returns {Promise<void>} Resolves after the delay.
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Durable scene -> session mapping, kept beside config.json. */
export class SessionMap {
  /**
   * @param {string} file Absolute path to sessions.json.
   */
  constructor(file) {
    this.file = file;
    /** @type {Record<string, string>} */
    this.entries = {};
    this.loaded = false;
  }

  /** Read the mapping file, tolerating absence and corruption. */
  async load() {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.entries = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code !== 'ENOENT') this.entries = {};
      this.entries = {};
    }
    this.loaded = true;
  }

  /**
   * @param {string} scene Scene key.
   * @returns {string | undefined} The bound session id.
   */
  get(scene) {
    return this.entries[scene];
  }

  /**
   * Bind a scene to a session and persist it.
   *
   * @param {string} scene Scene key.
   * @param {string} sessionId DSH session id.
   * @returns {Promise<void>} Resolves after the write.
   */
  async set(scene, sessionId) {
    await this.load();
    this.entries[scene] = sessionId;
    await this.#flush();
  }

  /**
   * Remove one binding.
   *
   * @param {string} scene Scene key.
   * @returns {Promise<void>} Resolves after the write.
   */
  async remove(scene) {
    await this.load();
    delete this.entries[scene];
    await this.#flush();
  }

  /** @returns {Record<string, string>} A copy of all bindings. */
  all() {
    return { ...this.entries };
  }

  /** Persist the mapping atomically. */
  async #flush() {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(this.entries, null, 2)}\n`, 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(temporary, this.file);
  }
}

/** Drives one DSH session per QQ scene through the session controller. */
export class DshDriver {
  /**
   * @param {object} options Driver options.
   * @param {any} options.controller The `ctx.sessionController` service.
   * @param {SessionMap} options.map Durable scene mapping.
   * @param {import('../policy/restrictions.js').GuestRegistry} [options.guests] Guest tier registry.
   * @param {SessionMap} [options.guestStore] Durable `sessionId -> tier` store.
   * @param {(line: string) => void} [options.log] Diagnostic sink.
   */
  constructor(options) {
    this.controller = options.controller;
    this.map = options.map;
    this.guests = options.guests;
    this.guestStore = options.guestStore;
    this.log = options.log ?? (() => {});
    /** @type {(detail: string) => void} */
    this.onImageRejected = options.onImageRejected ?? (() => {});
    /** @type {(type: string) => void} */
    this.onEventType = options.onEventType ?? (() => {});
    /** @type {(data: any) => void} */
    this.onToolCall = options.onToolCall ?? (() => {});
    /** @type {(() => Promise<{ provider: string, model: string } | undefined>) | undefined} */
    this.chooseModel = options.chooseModel;
    /** @type {((sessionId: string) => Promise<void>) | undefined} */
    this.applyPermission = options.applyPermission;
  }

  /**
   * Return the scene's session, creating and binding one when absent.
   *
   * @param {string} scene Scene key.
   * @param {string | undefined} cwd Workspace directory for a new session.
   * @param {string} [tier] Tier that owns the session; anything but `owner` is restricted later.
   * @returns {Promise<string>} The session id.
   */
  async sessionFor(scene, cwd, tier = 'owner') {
    await this.map.load();
    const existing = this.map.get(scene);
    if (typeof existing === 'string' && existing !== '') return existing;

    const options = cwd === undefined || cwd === '' ? {} : { cwd };
    let sessionId;
    if (tier === 'owner' || this.guests === undefined) {
      const created = await this.controller.create(options);
      sessionId = created.sessionId;
    } else {
      // Pre-generate the identity so `agent/created` can recognize the guest
      // session before it starts running.
      const expected = `session-${randomUUID()}`;
      this.guests.expect(expected, tier);
      await this.guestStore?.set(expected, tier);
      const created = await this.controller.create({ ...options, sessionId: expected });
      sessionId = created.sessionId;
      if (sessionId !== expected) {
        this.guests.tiers.delete(expected);
        await this.guestStore?.remove(expected);
        this.guests.expect(sessionId, tier);
        await this.guestStore?.set(sessionId, tier);
      }
    }

    await this.map.set(scene, sessionId);
    // A fresh session inherits the deployment default, which can be a provider
    // without credentials. Pin a routable route right away so the first prompt
    // does not fail with "no API key".
    if (typeof this.chooseModel === 'function') {
      try {
        const route = await this.chooseModel();
        if (route !== undefined && route.provider !== '') {
          await this.#selectModel(sessionId, route);
        }
      } catch (error) {
        this.log(`select model for ${sessionId} failed: ${String(error?.message ?? error).slice(0, 120)}`);
      }
    }

    await this.applyPermission?.(sessionId).catch(error => this.log(`permission preset failed: ${String(error?.message ?? error).slice(0, 120)}`));
    this.log(`bound ${scene} -> ${sessionId} (${tier})`);
    return sessionId;
  }

  /**
   * Ask one question and wait for the turn to finish.
   *
   * @param {object} request The request.
   * @param {string} request.scene Scene key.
   * @param {string} request.text Prompt text.
   * @param {string | undefined} request.cwd Workspace directory for a new session.
   * @param {number} request.timeoutMs Maximum time to wait for a reply.
   * @param {AbortSignal} [request.signal] Caller cancellation.
   * @returns {Promise<{ sessionId: string, text: string, sessionBound: boolean }>} The reply.
   */
  /**
   * Rename one session, so the sidebar shows the QQ peer instead of a random id.
   *
   * @param {string} sessionId Target session.
   * @param {string} title Display title.
   * @returns {Promise<void>} Resolves after the attempt.
   */
  async rename(sessionId, title) {
    if (typeof title !== 'string' || title.trim() === '') return;
    await this.controller.rename({ sessionId, title: title.slice(0, 60) });
  }

  /**
   * Select the model, with the configured reasoning level when there is one.
   *
   * A provider that does not accept a level rejects the whole selection, so the
   * fallback retries without it rather than failing the turn.
   *
   * @param {string} sessionId Target session.
   * @param {{ provider: string, model: string, effort?: string }} route Route to install.
   * @returns {Promise<void>} Resolves after the selection.
   */
  async #selectModel(sessionId, route) {
    const effort = typeof route.effort === 'string' ? route.effort : '';
    const request = { sessionId, provider: route.provider, model: route.model };
    if (effort === '') {
      await this.controller.selectModel(request);
      return;
    }
    try {
      await this.controller.selectModel({ ...request, reasoningEffort: effort });
    } catch (error) {
      this.log(`reasoning effort ${effort} rejected for ${sessionId}: ${String(error?.message ?? error).slice(0, 100)}`);
      await this.controller.selectModel(request);
    }
  }

  async ask(request) {
    let sessionId = await this.sessionFor(request.scene, request.cwd, request.tier ?? 'owner');
    // An already-bound scene may point at a session created before the route was
    // pinned; re-select so a stale provider does not fail the turn.
    if (request.model !== undefined && request.model.provider !== '') {
      try {
        await this.#selectModel(sessionId, request.model);
      } catch (error) {
        this.log(`select model for ${sessionId} failed: ${String(error?.message ?? error).slice(0, 120)}`);
      }
    }
    request.onSession?.(sessionId);
    // Resumed sessions also need the preset: a session created elsewhere keeps
    // the deployment default until something writes its permission events.
    await this.applyPermission?.(sessionId).catch(error => this.log(`permission preset failed: ${String(error?.message ?? error).slice(0, 120)}`));
    try {
      return await this.#runTurn(sessionId, request);
    } catch (error) {
      if (!isMissingSession(error)) throw error;
      // The bound session vanished (deleted or never persisted): rebind once.
      this.log(`session ${sessionId} is gone; creating a new one`);
      await this.map.remove(request.scene);
      sessionId = await this.sessionFor(request.scene, request.cwd, request.tier ?? 'owner');
      request.onSession?.(sessionId);
      return await this.#runTurn(sessionId, request);
    }
  }

  /**
   * Admit one prompt and follow its turn.
   *
   * @param {string} sessionId Target session.
   * @param {{ text: string, timeoutMs: number, signal?: AbortSignal }} request The request.
   * @returns {Promise<{ sessionId: string, text: string, sessionBound: boolean }>} The reply text.
   */
  async #runTurn(sessionId, request) {
    const requestId = `qq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const abort = new AbortController();
    const forwardAbort = () => abort.abort();
    request.signal?.addEventListener('abort', forwardAbort, { once: true });

    let baseline = -1;
    let ourTurnStart = -1;
    let promptSeq = -1;
    let lastAssistant = -1;
    let reply = '';
    let reasoning = '';
    let sawAssistant = false;
    /** @type {{ kind: string, error?: { message: string } } | undefined} */
    let turnReason;
    /** @type {any} Token usage reported by the last assistant message. */
    let usage;
    /** Successful tool calls billed per request by the provider. */
    let searchCalls = 0;
    let fetchCalls = 0;

    /** Resolves when the turn ends, fails, or the stream closes. */
    let settle;
    const completion = new Promise(resolve => {
      settle = resolve;
    });

    const frames = this.controller.follow(
      { address: { kind: 'session', sessionId }, assistantStream: false },
      abort.signal,
    );

    const consumer = (async () => {
      try {
        for await (const frame of frames) {
          if (frame?.type === 'snapshot') {
            baseline = Number(frame.cursor ?? -1);
            continue;
          }
          if (frame?.type !== 'event') continue;
          const event = frame.event;
          const seq = Number(event?.seq ?? -1);
          const type = event?.type;
          // Remember every event type this run: it is how we learn the shape of
          // a tool-request event without guessing an API.
          if (typeof type === 'string') this.onEventType?.(type);
          // The payload carries the call id and arguments; the session id comes
          // from the frame envelope, so add it for the question bridge.
          if (type === 'tool/call') this.onToolCall?.({ ...event.data, sessionId });

          if (type === 'user/message' && event.data?.source?.rpcId === requestId) promptSeq = seq;
          if (type === 'turn/start' && ourTurnStart === -1 && seq > baseline) ourTurnStart = seq;

          const base = promptSeq !== -1 ? promptSeq : ourTurnStart;
          const callName = type === 'tool/call' ? String(event.data?.name ?? event.data?.toolName ?? '') : '';
          if (callName === 'web_search') searchCalls += 1;
          if (callName === 'web_fetch') fetchCalls += 1;
          if (type === 'assistant/message' && base !== -1 && seq > base) {
            usage = event.data?.message?.usage ?? event.data?.usage ?? usage;
            for (const block of event.data?.message?.content ?? []) {
              if (block?.type === 'text' && typeof block.text === 'string') reply += block.text;
              if (block?.type === 'reasoning' && typeof block.text === 'string') reasoning += block.text;
            }
            lastAssistant = seq;
            sawAssistant = true;
          }
          if (type === 'turn/end' && base !== -1 && seq > base) {
            const afterAssistant = lastAssistant === -1 || seq > lastAssistant;
            if (afterAssistant) {
              turnReason = event.data?.reason;
              settle('ended');
              return;
            }
          }
        }
        settle('closed');
      } catch (error) {
        if (abort.signal.aborted) settle('aborted');
        else settle(new Error(`follow failed: ${error?.message ?? error}`));
      }
    })();

    // Wait for the opening snapshot so a turn already in flight cannot be
    // mistaken for ours, then admit the prompt into the already-open stream.
    for (let waited = 0; baseline === -1 && waited < 3000; waited += 50) await sleep(50);

    const textOnly = [{ type: 'text', text: request.text }];
    const content = Array.isArray(request.content) && request.content.length > 0 ? request.content : textOnly;
    try {
      await this.controller.prompt(
        { requestId, sessionId, mode: 'queue', content },
        AbortSignal.timeout(10_000),
      );
    } catch (error) {
      // An image payload the Host refused must not cost the whole turn: retry
      // with the text alone so the user still gets an answer.
      if (content.length > 1) {
        const detail = describeFailure(error);
        this.onImageRejected(detail);
        this.log(`prompt with attachments rejected (${detail}); retrying as text`);
        try {
          await this.controller.prompt(
            { requestId, sessionId, mode: 'queue', content: textOnly },
            AbortSignal.timeout(10_000),
          );
        } catch (retryError) {
          abort.abort();
          throw new Error(`prompt rejected: ${describeFailure(retryError)}`);
        }
      } else {
        abort.abort();
        throw new Error(`prompt rejected: ${describeFailure(error)}`);
      }
    }

    let timer;
    const outcome = await Promise.race([
      completion,
      new Promise(resolve => {
        timer = setTimeout(() => resolve('timeout'), request.timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    abort.abort();

    if (outcome === 'timeout') {
      abort.abort();
      try {
        this.controller.cancel({ sessionId });
      } catch {
        // The turn may already be gone; nothing to cancel.
      }
      throw new Error('turn timed out');
    }
    if (outcome === 'aborted') throw new Error('cancelled');
    if (outcome instanceof Error) throw outcome;

    void consumer;
    const text = reply.trim();
    const failure = turnReason?.kind === 'error' ? turnReason.error?.message : undefined;
    if (text === '' && failure !== undefined) throw new Error(`agent failed: ${failure}`);
    return { sessionId, text, reasoning: reasoning.trim(), sessionBound: true, usage, searchCalls, fetchCalls };
  }
}

/**
 * Whether a controller error means the session no longer exists.
 *
 * @param {any} error The thrown error.
 * @returns {boolean} True for a missing-session failure.
 */
function isMissingSession(error) {
  const code = error?.code ?? error?.info?.code;
  return code === 'session/not-found' || String(error?.message ?? '').includes('session/not-found');
}

/**
 * Summarize a controller failure for a log line or a QQ message.
 *
 * @param {any} error The thrown error.
 * @returns {string} Code, message, and any structured details.
 */
function describeFailure(error) {
  const code = error?.code ?? error?.info?.code ?? 'unknown';
  const message = error?.message ?? String(error);
  const details = error?.details ?? error?.info?.details;
  let suffix = '';
  if (details !== undefined) {
    try {
      suffix = ` ${JSON.stringify(details).slice(0, 160)}`;
    } catch {
      suffix = '';
    }
  }
  return `${code}: ${message}${suffix}`;
}

