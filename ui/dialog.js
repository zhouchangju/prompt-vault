// Works with the existing backdrop-based dialogs; only the top dialog handles keys.
const stack = [];
const installed = new WeakSet();
const selector = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]';
function focusables(dialog) { return [...dialog.querySelectorAll(selector)].filter(el => el.getClientRects().length && !el.closest('[inert]')); }
const originalInert = new Map();
let backgroundObserver;
function rememberInert(element) {
  if (!originalInert.has(element)) originalInert.set(element, element.inert);
}
function focusTop() {
  const dialog = stack.at(-1)?.dialog;
  if (dialog) (focusables(dialog)[0] || dialog.querySelector('[role="dialog"]') || dialog).focus();
}
function guardFocus(event) {
  const dialog = stack.at(-1)?.dialog;
  if (dialog && !dialog.contains(event.target)) focusTop();
}
function refreshLayers() {
  if (!stack.length) {
    backgroundObserver?.disconnect(); backgroundObserver = undefined;
    document.removeEventListener('focusin', guardFocus, true);
    for (const [element, inert] of originalInert) element.inert = inert;
    originalInert.clear();
    return;
  }
  const top = stack.at(-1).dialog;
  // Walk the top dialog's ancestor path so nested markup also has inert siblings.
  let branch = top;
  while (branch && branch !== document.body) {
    const parent = branch.parentElement;
    if (!parent) break;
    for (const sibling of parent.children) {
      if (sibling === branch) continue;
      const liveFeedback = sibling.matches('[role="status"],[aria-live]') &&
        !sibling.matches(selector) && !sibling.querySelector(selector);
      if (!liveFeedback) { rememberInert(sibling); sibling.inert = true; }
    }
    rememberInert(branch); branch.inert = false;
    branch = parent;
  }
  stack.forEach((entry, index) => {
    rememberInert(entry.dialog);
    entry.dialog.inert = index !== stack.length - 1 && !entry.dialog.contains(top);
    entry.dialog.style.zIndex = String(100 + index);
  });
  if (!backgroundObserver) {
    document.addEventListener('focusin', guardFocus, true);
    backgroundObserver = new MutationObserver(refreshLayers);
    backgroundObserver.observe(document.body, { childList: true, subtree: true });
  }
}
export function installDialog(dialog) {
  if (installed.has(dialog)) return;
  installed.add(dialog);
  const card = dialog.querySelector('[role="dialog"]') || dialog.firstElementChild || dialog;
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.tabIndex = -1;
  const heading = card.querySelector('h1,h2,h3');
  if (heading && !card.hasAttribute('aria-labelledby')) {
    heading.id ||= `${dialog.id || 'dialog'}-heading`;
    card.setAttribute('aria-labelledby', heading.id);
  }
  const dismiss = () => {
    dialog.dispatchEvent(new CustomEvent('dialog-dismiss', { bubbles: false }));
    if (stack.at(-1)?.dialog === dialog) closeDialog(dialog);
  };
  dialog.addEventListener('mousedown', event => {
    if (event.target === dialog && stack.at(-1)?.dialog === dialog) {
      event.preventDefault(); // Keep focus restored by closeDialog, not the hidden backdrop.
      dismiss();
    }
  });
  dialog.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (stack.at(-1)?.dialog !== dialog) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      dismiss();
    }
    if (event.key === 'Tab') {
      const list = focusables(dialog); const first = list[0]; const last = list.at(-1);
      if (!first) { event.preventDefault(); card.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !list.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !list.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  });
}
export function openDialog(dialog) {
  installDialog(dialog);
  if (stack.some(entry => entry.dialog === dialog)) return;
  const previous = document.activeElement;
  stack.push({ dialog, previous, cardId: previous.closest?.('[data-prompt-id]')?.dataset.promptId, action: previous.dataset?.action });
  dialog.classList.remove('hidden'); refreshLayers();
  (focusables(dialog)[0] || dialog.firstElementChild || dialog).focus();
}
export function closeDialog(dialog) {
  const index = stack.findIndex(entry => entry.dialog === dialog);
  dialog.classList.add('hidden');
  if (index < 0) return;
  const wasTop = index === stack.length - 1;
  const [{ previous, cardId, action }] = stack.splice(index, 1); refreshLayers();
  if (wasTop && previous?.isConnected && !previous.closest('.hidden,[inert]')) previous.focus();
  else if (wasTop && stack.length) focusables(stack.at(-1).dialog)[0]?.focus();
  else if (wasTop && cardId) {
    const card = [...document.querySelectorAll('[data-prompt-id]')].find(element => element.dataset.promptId === cardId);
    (action ? card?.querySelector(`[data-action="${action}"]`) : card)?.focus({ preventScroll: true });
  }
}
export function asyncHandler(handler, reportError) {
  return (...args) => Promise.resolve().then(() => handler(...args)).catch(reportError);
}
