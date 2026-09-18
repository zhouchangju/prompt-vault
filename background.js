import { dispatchCommand } from './core/commands.js';
import { installPanelStateTracking } from './core/panel-toggle.js';

installPanelStateTracking();

// UI settings have read-time defaults; installation must not overwrite a
// concurrent preference write or a legacy settings migration.
async function configureExtension() {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: 'Prompt Vault' });
}

async function initialize() {
  try { await configureExtension(); }
  catch (error) {
    console.error('Prompt Vault initialization failed', error);
    await Promise.allSettled([
      chrome.action.setBadgeText({ text: '!' }),
      chrome.action.setTitle({ title: 'Prompt Vault 初始化失败，请在扩展管理页重新加载' })
    ]);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initialize();
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

chrome.commands.onCommand.addListener((command, tab) => {
  try {
    Promise.resolve(dispatchCommand(command, tab)).catch(error => console.error('Prompt Vault command failed', error));
  } catch (error) { console.error('Prompt Vault command failed', error); }
});


initialize();
