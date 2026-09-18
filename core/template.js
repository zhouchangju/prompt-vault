export function extractVariables(content) {
  const text = String(content || '');
  const regex = /{{\s*([^{}]+?)\s*}}/g;
  const byName = new Map();
  let match;

  while ((match = regex.exec(text))) {
    const raw = match[0];
    const body = match[1].trim();
    let name = body;
    let type = 'text';
    let defaultValue = '';
    let options = [];

    if (body.includes('::')) {
      const [left, ...rest] = body.split('::');
      name = left.trim();
      const spec = rest.join('::').trim();

      if (spec.startsWith('list-')) {
        type = 'select';
        options = spec.slice(5).split(';').map((v) => v.trim()).filter(Boolean);
        defaultValue = options[0] || '';
      } else if (spec.startsWith('number-')) {
        type = 'number';
        defaultValue = spec.slice(7);
      } else if (spec === 'largeText') {
        type = 'textarea';
      } else if (spec.startsWith('text-')) {
        type = 'text';
        defaultValue = spec.slice(5);
      }
    } else if (body.includes('|')) {
      const pipeIndex = body.indexOf('|');
      name = body.slice(0, pipeIndex).trim();
      defaultValue = body.slice(pipeIndex + 1).trim();
    }

    if (!name) continue;
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        label: name,
        type,
        defaultValue,
        options,
        tokens: [raw]
      });
    } else {
      byName.get(name).tokens.push(raw);
    }
  }

  return [...byName.values()];
}

export function resolveTemplate(content, variables, values = {}) {
  const replacements = new Map();
  for (const variable of variables) {
    const value = Object.hasOwn(values, variable.name) ? values[variable.name] : variable.defaultValue;
    for (const token of variable.tokens) replacements.set(token, String(value ?? ''));
  }
  return String(content ?? '').replace(/{{\s*[^{}]+?\s*}}/g, token => replacements.get(token) ?? token);
}
