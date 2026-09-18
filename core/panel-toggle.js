const states = new WeakMap();
const key = windowId => `panelVisible:${windowId}`;
function stateFor(api) {
  if (!states.has(api)) states.set(api, { visible: new Map(), writes: new Map(), pending: new Map(), revisions: new Map(), unsubscribe: null });
  return states.get(api);
}

function recordVisibility(api, windowId, visible) {
  const state = stateFor(api);
  state.visible.set(windowId, visible);
  const write = (state.writes.get(windowId) || Promise.resolve()).catch(() => {}).then(
    () => api.storage.session.set({ [key(windowId)]: visible })
  );
  state.writes.set(windowId, write);
  write.catch(error => console.error('Unable to save panel visibility', error));
  return write;
}

// Native events include toolbar clicks and Chrome's close button, not just our
// shortcut. Session storage survives service-worker suspension, not browser exit.
export function installPanelStateTracking(api = chrome) {
  const state = stateFor(api);
  if (state.unsubscribe) return state.unsubscribe;
  const record = (windowId, visible) => {
    if (!Number.isInteger(windowId) || windowId < 0) return;
    state.revisions.set(windowId, (state.revisions.get(windowId) || 0) + 1);
    void recordVisibility(api, windowId, visible);
  };
  const opened = info => record(info.windowId, true);
  const closed = info => record(info.windowId, false);
  api.sidePanel.onOpened.addListener(opened);
  api.sidePanel.onClosed.addListener(closed);
  state.unsubscribe = () => {
    api.sidePanel.onOpened.removeListener(opened);
    api.sidePanel.onClosed.removeListener(closed);
    state.unsubscribe = null;
    state.visible.clear();
  };
  return state.unsubscribe;
}

export function togglePanel(windowId, api = chrome) {
  const state = stateFor(api);
  if (api.sidePanel.onOpened && api.sidePanel.onClosed) installPanelStateTracking(api);
  if (state.pending.has(windowId)) return state.pending.get(windowId);
  const operation = new Promise((resolve, reject) => {
    const perform = saved => {
      try {
        // Do not await before open(): Chrome's native API callback carries the
        // command gesture, but a Promise continuation in the worker does not.
        const visible = state.visible.has(windowId) ? state.visible.get(windowId) : saved[key(windowId)] === true;
        const revision = state.revisions.get(windowId) || 0;
        const nativeOperation = visible ? api.sidePanel.close({ windowId }) : api.sidePanel.open({ windowId });
        Promise.resolve(nativeOperation).then(async () => {
          if ((state.revisions.get(windowId) || 0) === revision) {
            await recordVisibility(api, windowId, !visible).catch(() => {});
          }
          return visible ? 'closed' : 'opened';
        }).then(resolve, reject);
      } catch (error) { reject(error); }
    };
    if (state.visible.has(windowId)) perform(null);
    else api.storage.session.get(key(windowId), saved => {
      const error = api.runtime?.lastError;
      if (error) { reject(new Error(error.message)); return; }
      perform(saved);
    });
  });
  state.pending.set(windowId, operation);
  operation.finally(() => state.pending.delete(windowId)).catch(() => {});
  return operation;
}
