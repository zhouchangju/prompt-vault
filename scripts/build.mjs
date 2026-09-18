import { readFile, mkdir, mkdtemp, writeFile, rm, rename, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runtimeFiles } from './runtime-files.mjs';

const files = await runtimeFiles(process.cwd());
const entries = new Map();
for (const file of files) entries.set(file, await readFile(file));
entries.set('INSTALL.md', await readFile('docs/installation.md'));
for (const file of ['LICENSE', 'NOTICE']) if (existsSync(file)) entries.set(file, await readFile(file));

await mkdir('dist', { recursive: true });
if ((await lstat('dist')).isSymbolicLink()) throw new Error('dist must be a local directory, not a symbolic link');
const staging = await mkdtemp(path.join('dist', '.prompt-vault-build-'));
const output = path.join('dist', 'prompt-vault');
try {
  for (const [file, bytes] of entries) {
    const target = path.join(staging, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  // Replace only this generated directory; leave ZIPs and other dist outputs intact.
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
  console.log(`${output}/: ${entries.size} allowlisted files, ready to load unpacked in Chrome`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
