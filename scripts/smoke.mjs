#!/usr/bin/env node
/**
 * Activation smoke test.
 *
 * `node --check` only validates syntax; a forward reference or a missing service
 * still throws when `apply()` runs. This harness calls `apply()` with a stub
 * context and reports what blew up, so "the plugin silently did not load" is
 * caught before a restart instead of after one.
 *
 * Usage: node scripts/smoke.mjs
 */

import { apply } from '../src/index.js';

const disposers = [];
const registeredTools = [];
const registeredRoutes = [];

/**
 * Minimal stand-in for the Cordis plugin context.
 *
 * @returns {any} A context good enough for `apply()` to finish.
 */
function stubContext() {
  const controller = {
    modelCatalog: async () => ({ default: { provider: 'stub', model: 'stub' }, groups: [] }),
    list: async () => ({ items: [] }),
    inspect: async () => ({}),
    resolveAgent: async () => ({ failure: { code: 'stub' } }),
    projections: async () => ({}),
    create: async () => ({ sessionId: 'stub' }),
    prompt: async () => undefined,
    follow: () => (async function* empty() {})(),
  };
  return {
    effect(callback) {
      const result = callback();
      if (typeof result === 'function') disposers.push(result);
      return () => {};
    },
    on() {
      return () => {};
    },
    get(name) {
      if (name === 'attachments' || name === 'userQuestions' || name === 'llm') return undefined;
      return undefined;
    },
    sessionController: controller,
    tools: {
      register(definition) {
        registeredTools.push(definition.name);
        return () => {};
      },
      guard() {
        return () => {};
      },
      schemas: () => [],
      restrict: () => {},
    },
    webServer: {
      register(route) {
        registeredRoutes.push(route);
        return () => {};
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  };
}

let failure = null;
try {
  apply(stubContext());
  // Give the async side effects one tick to surface their own errors.
  await new Promise(resolve => setTimeout(resolve, 50));
} catch (error) {
  failure = error;
}

for (const dispose of disposers) {
  try {
    dispose();
  } catch {
    // Disposal problems are not activation problems.
  }
}

if (failure !== null) {
  console.error(`ACTIVATION FAILED: ${failure?.name ?? 'Error'}: ${failure?.message ?? failure}`);
  if (failure?.stack) console.error(String(failure.stack).split('\n').slice(1, 6).join('\n'));
  process.exit(1);
}

console.log('activation ok');
console.log(`tools registered: ${registeredTools.length}${registeredTools.length > 0 ? ` (${registeredTools.join(', ')})` : ''}`);
console.log(`routes registered: ${registeredRoutes.length}`);
process.exit(0);
