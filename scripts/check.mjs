import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { runtimeFiles } from './runtime-files.mjs';

const root = process.cwd();
const files = await runtimeFiles(root);
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(manifest.version, pkg.version, 'Manifest/package versions must match');
assert.equal(manifest.manifest_version, 3);
assert.deepEqual([...manifest.permissions].sort(), ['clipboardWrite', 'sidePanel', 'storage']);
JSON.parse(await readFile('examples/sample-prompts.json', 'utf8'));
let syntaxCount = 0;
async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'test-results', 'playwright-report'].includes(entry.name) || entry.name.startsWith('.')) continue;
    const file = path.join(directory, entry.name);
    result.push(...(entry.isDirectory() ? await walk(file) : [file]));
  }
  return result;
}
let linkCount = 0;
for (const file of await walk(root)) {
  if (/\.(?:m?js)$/.test(file)) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    syntaxCount++;
  }
  if (!file.endsWith('.md')) continue;
  const text = (await readFile(file, 'utf8')).replace(/```[\s\S]*?```/g, '');
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z]+:|^#/i.test(target)) continue;
    assert(existsSync(path.resolve(path.dirname(file), target.split('#')[0])), `Broken link in ${file}: ${target}`);
    linkCount++;
  }
}
console.log(`PASS: ${files.length} local runtime assets, ${syntaxCount} JS syntax checks, ${linkCount} documentation links`);
