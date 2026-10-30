/**
 * Temporary diagnostic bundle for DSH-to-QQ.
 *
 * It answers one question: can a profile-installed Host plugin call
 * `ctx.sessionController` methods directly, in process, and pass the access
 * checks that the Remote gateway normally applies?
 *
 * Every check is read-only. `prompt` is deliberately not exercised: it would
 * enqueue a real user message into the session the probe runs in.
 */

/** Services needed to run the checks. */
export const inject = ['tools', 'sessionController'];

/**
 * Register the `qq_probe` diagnostic tool.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx The plugin context.
 */
export function apply(ctx) {
  const controller = ctx.sessionController;

  ctx.effect(() => ctx.tools.register({
    name: 'qq_probe',
    description: 'Report whether a Host plugin can call sessionController in process: list, modelCatalog, inspect, resolveAgent, projections, and the first frame of follow. Read-only and temporary.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: {
          type: 'string',
          description: 'Session to inspect and follow; defaults to the current session.',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args = {}, exec) {
      const sessionId = args.session_id ?? exec?.agent?.id;
      /** @type {{ step: string, ok: boolean, ms: number, value?: unknown, error?: string }[]} */
      const checks = [];

      /**
       * Run one probe step and record its outcome.
       *
       * @param {string} step Label reported to the caller.
       * @param {() => Promise<unknown>} run The step body.
       */
      const record = async (step, run) => {
        const started = Date.now();
        try {
          checks.push({ step, ok: true, ms: Date.now() - started, value: await run() });
        } catch (error) {
          checks.push({
            step,
            ok: false,
            ms: Date.now() - started,
            error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
          });
        }
      };

      await record('list', async () => {
        const value = await controller.list({}, AbortSignal.timeout(5000));
        return { sessions: Array.isArray(value?.items) ? value.items.length : null };
      });

      await record('modelCatalog', async () => {
        const value = await controller.modelCatalog();
        return {
          groups: Array.isArray(value?.groups) ? value.groups.length : null,
          defaultModel: value?.default?.model ?? null,
        };
      });

      if (typeof sessionId === 'string') {
        await record('inspect', async () => {
          const value = await controller.inspect(sessionId, AbortSignal.timeout(5000));
          return { events: Array.isArray(value?.events) ? value.events.length : null };
        });

        await record('resolveAgent', async () => {
          const value = await controller.resolveAgent(sessionId);
          return value?.agent ? { agent: value.agent.id } : { error: value?.error?.code ?? 'unknown' };
        });

        await record('projections', async () => {
          const value = await controller.projections({ sessionId }, AbortSignal.timeout(5000));
          return { kind: value?.kind ?? null };
        });

        await record('follow', async () => {
          const abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), 3000);
          try {
            const frames = controller.follow(
              { address: { kind: 'session', sessionId }, assistantStream: true },
              abort.signal,
            );
            for await (const frame of frames) {
              return { firstFrame: frame?.type ?? typeof frame };
            }
            return { firstFrame: null, note: 'stream ended without a frame' };
          } finally {
            clearTimeout(timer);
            abort.abort();
          }
        });
      }

      const lines = checks.map(check =>
        `${check.ok ? 'OK  ' : 'FAIL'} ${check.step.padEnd(12)} ${check.ms}ms ${check.ok ? JSON.stringify(check.value) : check.error}`,
      );
      const passed = checks.filter(check => check.ok).length;
      const report = [
        `sessionController probe — ${passed}/${checks.length} passed`,
        `session ${typeof sessionId === 'string' ? sessionId : '(none)'}`,
        ...lines,
      ].join('\n');

      return { report, checks, sessionId: typeof sessionId === 'string' ? sessionId : null };
    },
    presentCall: () => ({ card: 'generic', title: 'Session controller probe', kind: 'read', rawInput: {} }),
  }));
}
