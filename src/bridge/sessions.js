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
  constructor(file, debug = () => {}) {
    this.file = file;
    /** @type {Record<string, string>} */
    this.entries = {};
    this.loaded = false;
    this.debug = debug;
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
    this.debug(`remove ${scene}`);
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
    try {
      const back = JSON.parse(await readFile(this.file, 'utf8'));
      this.debug(`flush ${Object.keys(back).join(',') || '(empty)'}`);
    } catch {
      // Diagnostics only.
    }
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
    /** @type {any} Optional `ctx.workspaceRegistry`; sessions join a Workspace through it. */
    this.workspaces = options.workspaceRegistry;
    this.map = options.map;
    this.guests = options.guests;
    this.guestStore = options.guestStore;
    this.log = options.log ?? (() => {});
    /** Optional structured trace sink (temporary diagnostics). */
    this.debug = options.debug ?? (() => {});
    /** Scene -> in-flight first binding, so concurrent asks share one session. */
    this.pending = new Map();
    /** @type {(detail: string) => void} */
    this.onImageRejected = options.onImageRejected ?? (() => {});
    /** @type {(type: string) => void} */
    this.onEventType = options.onEventType ?? (() => {});
    /** @type {(data: any) => void} */
    this.onToolCall = options.onToolCall ?? (() => {});
    /** @type {(() => Promise<{ provider: string, model: string } | undefined>) | undefined} */
    this.chooseModel = options.chooseModel;
    /** @type {Map<string, string>} sessionId -> installed route signature. */
    this.routes = new Map();
    /** @type {Map<string, number>} tier -> last reconcile check. */
    this.routeChecks = new Map();
    /** @type {((sessionId: string) => Promise<void>) | undefined} */
    this.applyPermission = options.applyPermission;
    /** @type {Map<string, AbortController>} Standing watchers, one per session. */
    this.watchers = new Map();
  }

  /**
   * Follow a session forever and report answers this bridge did not ask for.
   *
   * A subagent finishing, a timer firing or any other host-injected turn runs a
   * turn in the same session without going through `ask()`, so nothing is
   * listening and the model's text would stay inside DSH. The watcher listens
   * permanently and hands back exactly those turns; turns started by `ask()`
   * carry an `rpcId` beginning with `qq-` and are left alone, so a reply is
   * never sent twice.
   *
   * @param {string} sessionId Session to watch.
   * @param {(text: string) => Promise<void> | void} onText Delivers an unwatched turn's text.
   * @returns {void}
   */
  watch(sessionId, onText) {
    const id = String(sessionId ?? '');
    if (id === '' || this.watchers.has(id)) return;
    const abort = new AbortController();
    this.watchers.set(id, abort);
    void this.#watchLoop(id, onText, abort.signal);
  }

  /** Stop watching one session (its binding was replaced or removed). */
  unwatch(sessionId) {
    const id = String(sessionId ?? '');
    const abort = this.watchers.get(id);
    if (abort === undefined) return;
    this.watchers.delete(id);
    abort.abort();
  }

  /**
   * @param {string} sessionId Session to follow.
   * @param {(text: string) => Promise<void> | void} onText Sink for foreign turns.
   * @param {AbortSignal} signal Stops the loop.
   * @returns {Promise<void>} Resolves when the stream ends.
   */
  async #watchLoop(sessionId, onText, signal) {
    /** Prompt that opened the current turn; `null` until one is seen, `qq-` means `ask()` owns it. */
    let promptRpc = null;
    /** True once any prompt was seen in this turn, rpcId or not. */
    let promptSeen = false;
    let text = '';
    try {
      const frames = this.controller.follow(
        { address: { kind: 'session', sessionId }, assistantStream: false },
        signal,
      );
      for await (const frame of frames) {
        if (frame?.type === 'snapshot') {
          // The stream opens with a snapshot, and whatever is inside it never
          // arrives again as an event. When the window stops mid-turn (no closing
          // `turn/end`), the prompt that opened that turn exists only here:
          // dropping its `rpcId` makes this watcher read `ask()`'s own reply as a
          // foreign turn and send the person a second copy. Text seen only in the
          // window is still ignored on purpose — a turn this watcher never saw
          // start is not one it may deliver.
          text = '';
          const records = Array.isArray(frame.records) ? frame.records : [];
          for (let index = records.length - 1; index >= 0; index -= 1) {
            const event = records[index]?.event;
            if (event?.type === 'turn/end') break;
            if (event?.type === 'user/message') {
              const rpc = String(event.data?.source?.rpcId ?? '');
              if (rpc !== '') {
                promptRpc = rpc;
                break;
              }
            }
          }
          continue;
        }
        if (frame?.type !== 'event') continue;
        const event = frame.event;
        const type = event?.type;
        if (type === 'user/message') {
          promptSeen = true;
          const rpc = String(event.data?.source?.rpcId ?? '');
          // Only an rpcId names the prompt that opened a turn. The Host also
          // splices messages into a running one — approval-policy changes,
          // runtime-context snapshots — and those carry no rpcId. Letting one
          // overwrite the owner made `ask()`'s own reply look foreign, so the
          // person got it twice (approval resumed turns included).
          if (rpc !== '') {
            promptRpc = rpc;
            text = '';
          }
          continue;
        }
        if (type === 'assistant/message') {
          for (const block of event.data?.message?.content ?? []) {
            if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
          }
          continue;
        }
        if (type === 'turn/end') {
          // Deliver a turn this bridge did not start — a background subagent
          // reporting back opens one of those, and staying quiet loses the
          // answer. A turn with no prompt at all is the one case to keep quiet:
          // the watcher joined mid-turn, so it cannot tell whose turn it is.
          const owned = promptRpc !== null && promptRpc.startsWith('qq-');
          const sawPrompt = promptSeen;
          const body = text.trim();
          promptRpc = null;
          promptSeen = false;
          text = '';
          if (owned || !sawPrompt || body === '') continue;
          try {
            await onText(body);
          } catch (error) {
            this.log(`external turn delivery failed: ${String(error?.message ?? error).slice(0, 120)}`);
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        this.log(`watcher for ${sessionId} stopped: ${String(error?.message ?? error).slice(0, 120)}`);
      }
    } finally {
      this.watchers.delete(sessionId);
    }
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
    this.debug(`sessionFor ${scene} existing=${existing ?? 'none'}`);
    if (typeof existing === 'string' && existing !== '') {
      // An archived session still answers prompts, so the mapping would look
      // healthy while every message landed in a session the sidebar hides.
      // The host also drops archived rows from `list`, so a binding missing
      // there is stale too. Rebind instead of writing into the void.
      const state = await this.#bindingState(existing);
      if (state === 'live') return existing;
      this.log(`session ${existing} for ${scene} is ${state}; binding a fresh one`);
      await this.map.remove(scene);
      this.archivedCache = undefined;
    }
    // Concurrent asks for the same unbound scene must share one creation:
    // otherwise a batch sync creates one session per request.
    const running = this.pending.get(scene);
    if (running !== undefined) return running;
    const creation = this.#bindNew(scene, cwd, tier).finally(() => this.pending.delete(scene));
    this.pending.set(scene, creation);
    return creation;
  }

  /**
   * Create a session for an unbound scene, bind it, and prepare it for turns.
   *
   * @param {string} scene Scene key.
   * @param {string | undefined} cwd Workspace directory for a new session.
   * @param {string} tier Tier that owns the session.
   * @returns {Promise<string>} The session id.
   */
  async #bindNew(scene, cwd, tier) {
    const options = await this.#sessionOptions(cwd);
    let sessionId;
    if (tier === 'owner' || this.guests === undefined) {
      const created = await this.#create(options);
      sessionId = created.sessionId;
    } else {
      // Pre-generate the identity so `agent/created` can recognize the guest
      // session before it starts running.
      const expected = `session-${randomUUID()}`;
      this.guests.expect(expected, tier);
      await this.guestStore?.set(expected, tier);
      const created = await this.#create(options, { sessionId: expected });
      sessionId = created.sessionId;
      if (sessionId !== expected) {
        this.guests.tiers.delete(expected);
        await this.guestStore?.remove(expected);
        this.guests.expect(sessionId, tier);
        await this.guestStore?.set(sessionId, tier);
      }
    }

    await this.map.set(scene, sessionId);
    this.debug(`mapped ${scene} -> ${sessionId}`);
    // A fresh session inherits the deployment default, which can be a provider
    // without credentials. Pin a routable route right away so the first prompt
    // does not fail with "no API key".
    if (typeof this.chooseModel === 'function') {
      try {
        const route = await this.chooseModel(tier);
        if (route !== undefined && route.provider !== '') {
          await this.#selectModel(sessionId, route);
          this.routes.set(sessionId, `${route.provider}|${route.model}|${route.effort ?? ''}`);
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
   * Whether a bound session can still receive messages.
   *
   * Every inbound message asks, and archiving is rare, so the answer is reused
   * for a few seconds. A failed or empty list keeps the existing binding on
   * purpose: treating a transient error as "missing" would scatter the history
   * across sessions nothing points at any more.
   *
   * @param {string} sessionId Candidate session.
   * @returns {Promise<'live' | 'archived' | 'missing' | 'unknown'>} Its state.
   */
  async #bindingState(sessionId) {
    const now = Date.now();
    if (this.archivedCache !== undefined && now - this.archivedAt < 5000) {
      return this.archivedCache.get(sessionId) ?? 'live';
    }
    /** @type {Map<string, 'live' | 'archived'>} */
    const states = new Map();
    try {
      const value = await this.controller.list({}, AbortSignal.timeout(8000));
      const raw = Array.isArray(value)
        ? value
        : Array.isArray(value?.items) ? value.items
          : Array.isArray(value?.sessions) ? value.sessions
            : [];
      for (const item of raw) {
        if (item === null || typeof item !== 'object') continue;
        const id = item.id ?? item.sessionId;
        if (typeof id !== 'string' || id === '') continue;
        states.set(id, item.archived === true ? 'archived' : 'live');
      }
    } catch (error) {
      this.log(`session list failed: ${String(error?.message ?? error).slice(0, 120)}`);
      return 'unknown';
    }
    this.archivedCache = states;
    this.archivedAt = now;
    if (states.size === 0) return 'unknown';
    return states.get(sessionId) ?? 'missing';
  }

  /**
   * Build the `session.create` options for a configured working directory.
   *
   * `session.create` accepts either `cwd` or `workspaceId`. With only `cwd` the
   * host does not attach the session to any Workspace, so the sidebar files it
   * under "Ungrouped" even though its files live in that directory. Resolving
   * (or registering) the matching Workspace first keeps both true.
   *
   * @param {string | undefined} cwd Configured working directory.
   * @returns {Promise<object>} Options for `controller.create`.
   */
  async #sessionOptions(cwd) {
    if (cwd === undefined || cwd === '') return {};
    const registry = typeof this.workspaces === 'function' ? this.workspaces() : this.workspaces;
    if (registry === undefined || typeof registry.list !== 'function') return { cwd };
    /** Compare paths the way Windows does: case- and trailing-separator-blind. */
    const normalize = value => String(value ?? '').replace(/[\\/]+$/, '').toLowerCase();
    try {
      const target = normalize(cwd);
      let workspace = registry.list().find(item => normalize(item.path) === target);
      if (workspace === undefined && typeof registry.create === 'function') {
        workspace = await registry.create(cwd);
        this.log(`workspace ${workspace.id} created for ${cwd}`);
      }
      if (workspace !== undefined) return { workspaceId: workspace.id };
    } catch (error) {
      this.log(`workspace lookup failed, staying with cwd: ${String(error?.message ?? error).slice(0, 120)}`);
    }
    return { cwd };
  }

  /**
   * Create a session, degrading to a plain `cwd` create if this Host rejects
   * `workspaceId` on the plugin-facing controller.
   *
   * @param {object} options Base options.
   * @param {object} [extra] Additional create options.
   * @returns {Promise<{ sessionId: string }>} The created session.
   */
  async #create(options, extra = {}) {
    try {
      return await this.controller.create({ ...options, ...extra });
    } catch (error) {
      if (options.workspaceId === undefined) throw error;
      this.log(`workspace create failed, retrying with cwd: ${String(error?.message ?? error).slice(0, 120)}`);
      const { workspaceId: _ignored, ...rest } = options;
      return await this.controller.create({ ...rest, ...extra });
    }
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

  /**
   * Re-select the model when the configured route changed for this tier.
   *
   * @param {string} sessionId Target session.
   * @param {string} tier Sender tier, choosing owner vs member route.
   * @returns {Promise<void>} Resolves after the attempt.
   */
  async #reconcileModel(sessionId, tier) {
    if (typeof this.chooseModel !== 'function') return;
    const tierKey = tier === 'owner' ? 'owner' : 'member';
    const last = this.routeChecks.get(tierKey) ?? 0;
    if (Date.now() - last < 30_000) return;
    this.routeChecks.set(tierKey, Date.now());
    try {
      const route = await this.chooseModel(tier);
      if (route === undefined || route.provider === '') return;
      const signature = `${route.provider}|${route.model}|${route.effort ?? ''}`;
      if (this.routes.get(sessionId) === signature) return;
      await this.#selectModel(sessionId, route);
      this.routes.set(sessionId, signature);
      this.log(`model reconciled for ${sessionId}: ${signature}`);
    } catch (error) {
      this.log(`reconcile model for ${sessionId} failed: ${String(error?.message ?? error).slice(0, 120)}`);
    }
  }

  async ask(request) {
    let sessionId = await this.sessionFor(request.scene, request.cwd, request.tier ?? 'owner');
    // Reconcile the model at most every 30s per tier, so a changed settings
    // route reaches existing sessions without a per-turn catalog fetch.
    await this.#reconcileModel(sessionId, request.tier ?? 'owner');
    request.onSession?.(sessionId);
    // Resumed sessions also need the preset: a session created elsewhere keeps
    // the deployment default until something writes its permission events.
    await this.applyPermission?.(sessionId).catch(error => this.log(`permission preset failed: ${String(error?.message ?? error).slice(0, 120)}`));
    try {
      return await this.#runTurn(sessionId, request);
    } catch (error) {
      if (!isMissingSession(error)) throw error;
      // The bound session vanished (deleted or never persisted): rebind once.
      this.debug(`rebind ${request.scene} from ${sessionId}: ${String(error?.message ?? error).slice(0, 160)}`);
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
    /** DSH condensed the history during this turn; fixed blocks are gone. */
    let compacted = false;

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
          if (type === 'compaction/end') compacted = true;
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

    // The Host owns the turn from here on: tell the bridge which request it was,
    // so a reload before the reply can be repaired by the next instance.
    request.onPrompt?.({ sessionId, requestId });

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
    return { sessionId, text, reasoning: reasoning.trim(), sessionBound: true, usage, searchCalls, fetchCalls, compacted };
  }

  /**
   * Read back the text of a turn `ask()` started but never delivered.
   *
   * A reload can dispose the instance between the Host's `turn/end` and the code
   * that posts the reply: the model's answer exists in the session, nobody sends
   * it, and no error is raised. The turn still carries the `qq-` request id it
   * was started with, so the next instance can recognize it — in the opening
   * snapshot when it already closed, in the live stream when the Host is still
   * finishing it — instead of guessing from text it never saw.
   *
   * @param {string} sessionId Session to read.
   * @param {string} requestId Request id the turn was started with.
   * @param {number} [timeoutMs] How long to wait for the turn to close.
   * @returns {Promise<{ text: string } | null>} The turn's text, or null when it cannot be read back.
   */
  async recoverTurn(sessionId, requestId, timeoutMs = 60_000) {
    const id = String(sessionId ?? '');
    const owner = String(requestId ?? '');
    if (id === '' || owner === '') return null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    timer.unref?.();
    let text = '';
    let opened = false;
    /**
     * Fold one event into the turn being read.
     *
     * @param {any} event The event.
     * @returns {string | undefined} The turn's text once it closed, else undefined.
     */
    const apply = event => {
      const type = event?.type;
      if (type === 'user/message') {
        // A later prompt closes this turn's claim: only the request id that
        // opened the turn may speak for it.
        opened = String(event.data?.source?.rpcId ?? '') === owner;
        text = '';
        return undefined;
      }
      if (opened !== true) return undefined;
      if (type === 'assistant/message') {
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
        }
        return undefined;
      }
      if (type === 'turn/end') return text.trim();
      return undefined;
    };
    try {
      const frames = this.controller.follow(
        { address: { kind: 'session', sessionId: id }, assistantStream: false },
        abort.signal,
      );
      for await (const frame of frames) {
        if (frame?.type === 'snapshot') {
          for (const record of Array.isArray(frame.records) ? frame.records : []) {
            const closed = apply(record?.event ?? record);
            if (closed !== undefined) return closed === '' ? null : { text: closed };
          }
          // The window may stop mid-turn; the closing event then arrives live.
          continue;
        }
        if (frame?.type !== 'event') continue;
        const closed = apply(frame.event);
        if (closed !== undefined) return closed === '' ? null : { text: closed };
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
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

