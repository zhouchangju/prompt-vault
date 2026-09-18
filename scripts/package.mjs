import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import assert from 'node:assert/strict';
import { runtimeFiles } from './runtime-files.mjs';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const files = await runtimeFiles(process.cwd());
const entries = {};
for (const file of files) entries[file] = new Uint8Array(await readFile(file));
entries['INSTALL.md'] = strToU8(await readFile('docs/installation.md', 'utf8'));
for (const file of ['LICENSE', 'NOTICE']) if (existsSync(file)) entries[file] = new Uint8Array(await readFile(file));
const archive = zipSync(entries, { level: 9, mtime: new Date('2026-01-01T00:00:00Z') });
assert.deepEqual(Object.keys(unzipSync(archive)).sort(), Object.keys(entries).sort());
await mkdir('dist', { recursive: true });
const output = `dist/prompt-vault-${manifest.version}.zip`;
await writeFile(output, archive);
console.log(`${output}: ${Object.keys(entries).length} allowlisted files, ${archive.length} bytes`);
