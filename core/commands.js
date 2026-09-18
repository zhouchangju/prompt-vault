import { togglePanel } from './panel-toggle.js';

export function executeCommand(command, tab, api = chrome) {
  if (command !== 'open-panel') return Promise.resolve();
  if (Number.isInteger(tab?.windowId) && tab.windowId >= 0) return togglePanel(tab.windowId, api);
  return new Promise((resolve, reject) => {
    api.windows.getLastFocused(window => {
      const error = api.runtime?.lastError;
      if (error) { reject(new Error(error.message)); return; }
      try { resolve(togglePanel(window.id, api)); } catch (failure) { reject(failure); }
    });
  });
}

export async function getCommandBindings(api = chrome) {
  const commands = await api.commands.getAll();
  return [
    { name: 'open-panel', label: '打开 / 收起侧边栏' }
  ].map(item => ({ ...item, shortcut: commands.find(command => command.name === item.name)?.shortcut || '' }));
}

// Only the browser onCommand listener calls this path; ordinary UI clicks
// never masquerade as a received shortcut.
export function dispatchCommand(command, tab, api = chrome) {
  if (command !== 'open-panel') return Promise.resolve();
  const at = Date.now();
  const record = async (status, message = '') => {
    try { await api.storage.session.set({ [`lastCommand:${command}`]: { at, status, message } }); }
    catch { /* Diagnostic recording must not prevent opening the UI. */ }
  };
  let operation;
  try { operation = executeCommand(command, tab, api); }
  catch (error) { operation = Promise.reject(error); }
  return Promise.resolve(operation).then(
    async result => { await record('success'); return result; },
    async error => { await record('failed', error.message); throw error; }
  );
}
