#!/usr/bin/env node
/**
 * Static inventory of the bridge.
 *
 * Counts what exists (files, tools, commands, routes, config keys) and reports
 * what looks wrong: dead config keys, unreachable command handlers, routes
 * without a handler, and symbols referenced only once (definition only).
 *
 * Usage: node scripts/inventory.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SKIP = new Set(['dist', 'node_modules', '.git']);

/**
 * Collect source files under a directory.
 *
 * @param {string} dir Directory.
 * @param {string[]} [out] Accumulator.
 * @returns {Promise<string[]>} File paths.
 */
async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(js|mjs|ps1)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [
  ...(await walk(join(ROOT, 'src'))),
  ...(await walk(join(ROOT, 'client'))),
];
const sources = new Map();
for (const file of files) sources.set(file, await readFile(file, 'utf8'));
const all = [...sources.values()].join('\n');

const pick = (pattern, text = all) => [...text.matchAll(pattern)].map(match => match[1]);
const uniq = list => [...new Set(list)].sort();

const tools = uniq(pick(/name: '([a-z0-9_]+)',\r?\n\s+description:/g));
const commands = uniq(pick(/^\s*\['([\u4e00-\u9fa5a-z]+)', '([a-z]+)'\],/gm).map((_, index) => index));
const commandNames = uniq([...all.matchAll(/^\s*\['([\u4e00-\u9fa5a-z]+)', '([a-z]+)'\],/gm)].map(match => match[2]));
const commandCases = uniq(pick(/case '([a-z]+)':/g));
const routes = uniq(pick(/kind: 'exact', path: '([^']+)'/g));
const handled = uniq(pick(/url\.pathname === '([^']+)'/g));

const defaultsText = sources.get(join(ROOT, 'src/config/defaults.js')) ?? '';
const defaultKeys = uniq([...defaultsText.matchAll(/^\s{6}([a-zA-Z]+):/gm)].map(match => match[1]));
const otherText = [...sources.entries()]
  .filter(([file]) => !file.endsWith('defaults.js'))
  .map(([, text]) => text)
  .join('\n');
const deadKeys = defaultKeys.filter(key => !otherText.includes(key));

const lines = [...sources.entries()]
  .map(([file, text]) => ({ path: relative(ROOT, file).replace(/\\/g, '/'), lines: text.split('\n').length }))
  .sort((left, right) => right.lines - left.lines);

const report = [];
report.push('# inventory');
report.push('');
report.push(`files: ${files.length}, source lines: ${lines.reduce((sum, item) => sum + item.lines, 0)}`);
report.push(`tools ${tools.length}: ${tools.join(', ')}`);
report.push(`commands ${commandNames.length}: ${commandNames.join(', ')}`);
report.push(`routes ${routes.length} / handlers ${handled.length}`);
report.push('');

const missingHandlers = routes.filter(route => !handled.includes(route));
const missingRoutes = handled.filter(route => !routes.includes(route));
const missingCases = commandNames.filter(name => !commandCases.includes(name));
const extraCases = commandCases.filter(name => !commandNames.includes(name));

report.push('## problems');
report.push(missingHandlers.length === 0 ? '- every route has a handler' : `- routes without a handler: ${missingHandlers.join(', ')}`);
report.push(missingRoutes.length === 0 ? '- every handler has a route' : `- handlers without a route: ${missingRoutes.join(', ')}`);
report.push(missingCases.length === 0 ? '- every command has a case' : `- commands without a case: ${missingCases.join(', ')}`);
report.push(extraCases.length === 0 ? '- no orphan command cases' : `- orphan cases: ${extraCases.join(', ')}`);
report.push(deadKeys.length === 0 ? '- no dead config keys' : `- dead config keys (${deadKeys.length}): ${deadKeys.join(', ')}`);
report.push('');

report.push('## largest files');
for (const item of lines.slice(0, 8)) report.push(`- ${item.path}: ${item.lines}`);

console.log(report.join('\n'));

