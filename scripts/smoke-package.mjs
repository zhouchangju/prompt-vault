import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';

execFileSync(process.execPath, ['scripts/package.mjs'], { stdio: 'inherit' });
const { version } = JSON.parse(await readFile('manifest.json', 'utf8'));
const entries = unzipSync(await readFile(`dist/prompt-vault-${version}.zip`));
const target = await mkdtemp(path.join(tmpdir(), 'prompt-vault-package-'));
try {
  for (const [name, bytes] of Object.entries(entries)) {
    const file = path.resolve(target, name);
    if (!file.startsWith(target + path.sep)) throw new Error('Unsafe archive path');
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
  }
  execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--grep', 'create once|all themes|original v1|manager whole cards|panel one-click|actual native|configuration stays local',
    '--output=.local/package-test-results', '--reporter=list'], {
    stdio: 'inherit', env: { ...process.env, PROMPT_VAULT_TEST_ROOT: target }
  });
} finally { await rm(target, { recursive: true, force: true }); }
