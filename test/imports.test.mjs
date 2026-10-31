import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A cheap lint for the one bug that `node --check` cannot see: a helper used in
 * a rarely-executed branch without its import, which only fails at runtime.
 *
 * The mapped helpers are the ones this project added recently; each name must
 * appear in an import statement whenever it is called.
 */
const HELPERS = ['filterNotes', 'sanitizeNote', 'compileWords', 'entrySignature', 'cleanupCandidates', 'formatRecap'];

async function sourceFiles(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

test('every helper a source file calls is imported in that file', async () => {
  const files = await sourceFiles(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const problems = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const helper of HELPERS) {
      const calls = new RegExp(`\\b${helper}\\(`).test(text);
      const defines = new RegExp(`export function ${helper}\\b`).test(text);
      const imports = new RegExp(`import[^;]*\\b${helper}\\b[^;]*from`, 's').test(text);
      if (calls && !defines && !imports) problems.push(`${file}: ${helper}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
