const finite = value => Number.isFinite(value) ? value : 0;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Persisted folder order; deterministic fallbacks also support old equal ranks. */
export function sortFolders(folders) {
  return [...folders].sort((a, b) => finite(a.sortOrder) - finite(b.sortOrder)
    || compareText(String(a.name || ''), String(b.name || ''))
    || compareText(String(a.id), String(b.id)));
}

/** Create once per panel document, never on focus or data refresh.
 * Capture ranking fields on first sight, while allowing favorite changes to
 * intentionally move groups. Deleted IDs retain their score for this session.
 */
export function createPanelOrder(initialPrompts = []) {
  const scores = new Map();
  function capture(prompts) {
    for (const prompt of prompts) {
      if (!scores.has(prompt.id)) scores.set(prompt.id, {
        useCount: finite(prompt.useCount), sortOrder: finite(prompt.sortOrder),
        createdAt: finite(prompt.createdAt)
      });
    }
  }
  capture(initialPrompts);
  return {
    sort(prompts) {
      capture(prompts);
      return [...prompts].sort((a, b) => {
        const first = scores.get(a.id);
        const second = scores.get(b.id);
        return Number(Boolean(b.favorite)) - Number(Boolean(a.favorite))
          || second.useCount - first.useCount
          || first.sortOrder - second.sortOrder
          || first.createdAt - second.createdAt
          || compareText(String(a.id), String(b.id));
      });
    }
  };
}
