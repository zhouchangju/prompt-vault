import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVariables, resolveTemplate } from '../core/template.js';
import { parseCsv, snapshotToCsv } from '../core/csv.js';
import { THEMES, normalizeSettings, getSettings, saveSettings } from '../core/settings.js';

test('template replacement is one pass and treats special names as own keys', () => {
  const source = '{{a}} {{b}} {{__proto__}} {{constructor}}';
  const values = Object.fromEntries([['a', '{{b}}'], ['b', '$&'], ['__proto__', 'safe']]);
  assert.equal(resolveTemplate(source, extractVariables(source), values), '{{b}} $& safe ');
});
test('variables retain defaults, uniqueness and typed options', () => {
  const source = '{{x|hello}} {{x}} {{count::number-2}} {{kind::list-a;b}}';
  const vars = extractVariables(source);
  assert.equal(vars.length, 3);
  assert.equal(resolveTemplate(source, vars, {}), 'hello hello 2 a');
});
test('CSV supports BOM, quoted newline, escaped quotes and CRLF', () => {
  assert.deepEqual(parseCsv('\uFEFFtitle,content\r\n"A, B","say ""hi""\nnext"\r\n'), [{title:'A, B',content:'say "hi"\nnext'}]);
});
test('CSV rejects malformed quotes, headers and row shapes', () => {
  for (const text of ['title,content\na,"oops', 'title,content\na,b"c', 'title,content\na,"b"x', 'title,title\na,b', 'title,content\na,b,c', 'title,x\na,b']) {
    assert.throws(() => parseCsv(text));
  }
});
test('CSV protects formula cells by default and exposes explicit raw option', () => {
  const snapshot = {prompts:[{title:' =SUM(A1)',content:'+1',tags:[]}]};
  const safe = parseCsv(snapshotToCsv(snapshot,new Map()))[0];
  assert.equal(safe.title,"' =SUM(A1)"); assert.equal(safe.content,"'+1");
  assert.equal(parseCsv(snapshotToCsv(snapshot,new Map(),{raw:true}))[0].content,'+1');
});
test('settings retain all themes and normalize invalid legacy values', () => {
  assert.equal(THEMES.length,13);
  assert.deepEqual(normalizeSettings({theme:'unknown',viewMode:'dense',cardDensity:'compact'}),{theme:'system',viewMode:'cards',cardDensity:'compact'});
});
test('independent concurrent preference writes do not overwrite each other', async () => {
  const data = {settings:{theme:'dark',cardDensity:'comfortable'}};
  globalThis.chrome = {storage:{local:{
    get: async keys => Object.fromEntries(keys.filter(k => Object.hasOwn(data,k)).map(k => [k,data[k]])),
    set: async values => {Object.assign(data,values);}
  }}};
  assert.equal((await getSettings()).theme,'dark');
  await Promise.all([saveSettings({theme:'forest'}),saveSettings({viewMode:'compact'})]);
  assert.deepEqual(await getSettings(),{theme:'forest',cardDensity:'comfortable',viewMode:'compact'});
  await assert.rejects(saveSettings({theme:'bogus'}));
  delete globalThis.chrome;
});
