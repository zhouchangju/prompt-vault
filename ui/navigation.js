// Opening the options page reuses Chrome's existing manager tab when possible.
export async function openManagerFromPanel({ newPrompt = false } = {}) {
  const sourceWindow = await chrome.windows.getCurrent();
  if (newPrompt) await chrome.tabs.create({ url: chrome.runtime.getURL('manager.html?new=1') });
  else await chrome.runtime.openOptionsPage();

  if (chrome.sidePanel?.close && Number.isInteger(sourceWindow.id)) {
    try {
      await chrome.sidePanel.close({ windowId: sourceWindow.id });
      return;
    } catch {
      // Also permits testing/opening sidepanel.html as a standalone extension tab.
    }
  }
  window.close();
}
