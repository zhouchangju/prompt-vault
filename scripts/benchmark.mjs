import { chromium } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, platform, arch } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const profile = await mkdtemp(path.join(tmpdir(), 'prompt-vault-benchmark-'));
const root = process.cwd();
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
  viewport: { width: 1440, height: 1000 }, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
const results = [];
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  const url = `chrome-extension://${new URL(worker.url()).host}/manager.html`;
  await page.goto(url);
  for (const count of [100, 1000, 10000]) {
    const fixture = { schemaVersion: 1, folders: [], prompts: Array.from({ length: count }, (_, i) => ({
      id: `benchmark-${i}`, title: `合成提示 ${i}`, tags: ['benchmark'],
      content: `needle-${String(i).padStart(6, '0')}~ ${'本地性能基准文本。'.repeat(80)}`
    })) };
    await page.evaluate(async data => { const db = await import('./db.js'); await db.clearAllData(); await db.importSnapshot(data); }, fixture);
    const startup = [];
    for (let run = 0; run < 3; run++) {
      await page.reload();
      await page.waitForFunction(count => document.querySelector('#allCount').textContent === String(count) && document.querySelectorAll('#cardsGrid article').length >= 60, count);
      startup.push(await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))))));
    }
    const search = [];
    for (let run = 0; run < 5; run++) {
      search.push(await page.evaluate(query => new Promise((resolve, reject) => {
        const start = performance.now();
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Search benchmark timeout')); }, 5000);
        const observer = new MutationObserver(() => {
          if (document.querySelector('#pageSubtitle').textContent !== '找到 1 个匹配结果') return;
          observer.disconnect(); clearTimeout(timer);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
        });
        observer.observe(document.querySelector('#pageSubtitle'), { childList: true });
        const input = document.querySelector('#searchInput'); input.value = query;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }), `needle-${String(run).padStart(6, '0')}~`));
    }
    await page.locator('#searchInput').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#cardsGrid article').length >= 60);
    const scrollStart = Date.now();
    await page.locator('#loadSentinel').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('#cardsGrid article').length > 60);
    const scrollMs = Date.now() - scrollStart;
    const stats = values => ({ samples: values.map(v => Math.round(v)), median: Math.round([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]), max: Math.round(Math.max(...values)) });
    const result = { count, contentChars: fixture.prompts[0].content.length, startupMs: stats(startup), searchMs: stats(search), appendMs: scrollMs,
      rendered: await page.locator('#cardsGrid article').count() };
    results.push(result); console.log(JSON.stringify(result));
    assert(result.startupMs.max < 3000, 'Startup acceptance target: <3000ms');
    assert(result.searchMs.max < 1000, 'Search acceptance target incl debounce: <1000ms');
    assert(scrollMs < 2000, 'First incremental append acceptance target: <2000ms');
  }
  await mkdir('.local', { recursive: true });
  await writeFile('.local/benchmark.json', JSON.stringify({ timestamp: new Date().toISOString(), browser: context.browser().version(), node: process.version,
    platform: `${platform()}/${arch()}`, viewport: '1440x1000', targets: { startupMs: 3000, searchMs: 1000, appendMs: 2000 }, results }, null, 2));
} finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
