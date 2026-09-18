import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

// Only assets reachable from declared extension entry points enter a release.
export async function runtimeFiles(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const pending = ['manifest.json', manifest.background.service_worker,
    manifest.side_panel.default_path, manifest.options_page, ...Object.values(manifest.icons)];
  const files = new Set();
  const absoluteRoot = await realpath(root);
  while (pending.length) {
    const relative = path.posix.normalize(pending.pop());
    if (!/^(?:[\w-]+\.(?:js|html|css|json)|(?:core|storage|ui|icons)\/[\w/-]+\.(?:js|css|png|svg))$/.test(relative)) {
      throw new Error(`Release path outside asset allowlist: ${relative}`);
    }
    if (files.has(relative)) continue;
    const absolute = await realpath(path.join(root, relative));
    if (!absolute.startsWith(absoluteRoot + path.sep)) throw new Error(`External asset: ${relative}`);
    files.add(relative);
    const source = await readFile(absolute, 'utf8');
    const references = [];
    if (relative.endsWith('.html')) {
      for (const match of source.matchAll(/(?:src|href)=["']([^"']+)["']/g)) references.push(match[1]);
    } else if (relative.endsWith('.js')) {
      for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) references.push(match[1]);
    } else if (relative.endsWith('.css')) {
      for (const match of source.matchAll(/@import\s+["']([^"']+)["']/g)) references.push(match[1]);
      for (const match of source.matchAll(/url\(["']?([^\s)'"#]+)["']?\)/g)) references.push(match[1]);
    }
    for (const reference of references) {
      if (/^(?:[a-z]+:|\/\/|\/)/i.test(reference)) throw new Error(`Non-local runtime asset in ${relative}`);
      pending.push(path.posix.join(path.posix.dirname(relative), reference));
    }
  }
  return [...files].sort();
}
