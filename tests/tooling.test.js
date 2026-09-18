import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runtimeFiles } from '../scripts/runtime-files.mjs';

test('runtime release graph excludes private/tooling assets and includes shared modules', async () => {
  const files = await runtimeFiles(process.cwd());
  assert(files.includes('core/validation.js')); assert(files.includes('themes.css')); assert(files.includes('ui/dialog.js'));
  assert(!files.some(file => /node_modules|tests\/|scripts\/|\.local|\.env|\.DS_Store/.test(file)));
});
test('release graph fails closed on missing or remote runtime dependencies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prompt-vault-package-'));
  try {
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ background: {service_worker:'background.js'}, side_panel: {default_path:'page.html'}, options_page:'page.html', icons:{} }));
    await writeFile(path.join(root, 'page.html'), '<script type="module" src="background.js"></script>');
    await writeFile(path.join(root, 'background.js'), 'import "./missing.js";');
    await assert.rejects(runtimeFiles(root));
    await writeFile(path.join(root, 'background.js'), 'import "https://example.com/remote.js";');
    await assert.rejects(runtimeFiles(root), /Non-local/);
    await mkdir(path.join(root, '.private'));
    await writeFile(path.join(root, '.private', 'data.js'), 'export const privateData = 1;');
    await writeFile(path.join(root, 'background.js'), 'import "./.private/data.js";');
    await assert.rejects(runtimeFiles(root), /allowlist/);
  } finally { await rm(root, { recursive:true, force:true }); }
});
test('packaged icon dimensions match manifest sizes', async () => {
  for (const size of [16,32,48,128]) {
    const png = await readFile(`icons/icon${size}.png`);
    assert.equal(png.readUInt32BE(16),size); assert.equal(png.readUInt32BE(20),size);
  }
});
