/**
 * No-op plugin. Its only job is to make pnpm install the `@deepseek-ai/*`
 * packages declared in package.json into the profile's node_modules.
 */

/** Nothing to provide. */
export const inject = [];

/** Do nothing. */
export function apply() {}
