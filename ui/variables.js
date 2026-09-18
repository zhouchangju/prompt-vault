export function createVariableField(variable) {
  const label = document.createElement('label');
  const text = document.createElement('span'); text.textContent = variable.label;
  const multiline = variable.type !== 'select' && variable.type !== 'number';
  const input = document.createElement(variable.type === 'select' ? 'select' : multiline ? 'textarea' : 'input');
  if (variable.type === 'select') for (const option of variable.options) input.add(new Option(option, option));
  else if (!multiline) input.type = 'number';
  if (multiline) input.rows = variable.type === 'textarea' ? 8 : 6;
  input.value = variable.defaultValue ?? '';
  input.dataset.variableName = variable.name;
  label.append(text, input); return label;
}
export function renderVariableFields(container, variables) {
  container.replaceChildren(...variables.map(createVariableField));
}
export function readVariableValues(container) {
  return Object.fromEntries([...container.querySelectorAll('[data-variable-name]')].map(input => [input.dataset.variableName, input.value]));
}
