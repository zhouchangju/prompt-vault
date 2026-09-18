export const THEMES = Object.freeze([
  ['system', '跟随系统'], ['winter', '冬季'], ['light', '浅色'], ['dark', '深色', true],
  ['night', '夜间', true], ['cyberpunk', '赛博朋克'], ['retro', '复古'], ['valentine', '情人节'],
  ['aqua', '水蓝'], ['nord', '北欧'], ['lemonade', '柠檬水'], ['forest', '森林', true], ['luxury', '奢华', true]
].map(([id, label, dark = false]) => Object.freeze({ id, label, dark })));
const defaults = { theme: 'system', cardDensity: 'comfortable', viewMode: 'cards' };
const allowed = { theme: THEMES.map(t => t.id), cardDensity: ['comfortable', 'compact'], viewMode: ['cards', 'compact'] };
const key = field => `preference.${field}`;
export function normalizeSettings(value = {}) {
  return Object.fromEntries(Object.entries(defaults).map(([field, fallback]) =>
    [field, allowed[field].includes(value?.[field]) ? value[field] : fallback]));
}
export async function getSettings() {
  const stored = await chrome.storage.local.get(['settings', ...Object.keys(defaults).map(key)]);
  const settings = { ...stored.settings };
  for (const field of Object.keys(defaults)) if (Object.hasOwn(stored, key(field))) settings[field] = stored[key(field)];
  return normalizeSettings(settings);
}
export async function saveSettings(next) {
  const writes = {};
  for (const [field, value] of Object.entries(next)) {
    if (!Object.hasOwn(allowed, field) || !allowed[field].includes(value)) throw new Error(`无效设置：${field}`);
    writes[key(field)] = value;
  }
  await chrome.storage.local.set(writes);
  return getSettings();
}
export function watchSettings(callback) {
  let generation = 0;
  const listener = (changes, area) => {
    if (area !== 'local' || !Object.keys(changes).some(k => k === 'settings' || k.startsWith('preference.'))) return;
    const current = ++generation;
    getSettings().then(settings => { if (current === generation) callback(settings); }).catch(error => console.error('读取设置失败', error));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => { generation++; chrome.storage.onChanged.removeListener(listener); };
}
export function applyTheme(theme) {
  document.documentElement.dataset.theme = normalizeSettings({ theme }).theme;
}
