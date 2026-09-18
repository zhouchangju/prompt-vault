import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES } from '../core/settings.js';

const css = readFileSync(new URL('../themes.css', import.meta.url), 'utf8');
const palettes = [...css.matchAll(/(:root[^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selector: selector.trim(),
  tokens: Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/g)].map(([, key, value]) => [key, value]))
})).filter(({ tokens }) => tokens.bg);
function luminance(hex) {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(first, second) {
  const [low, high] = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}

test('every theme has a palette, including system dark override', () => {
  for (const { id } of THEMES) assert.ok(palettes.some(({ selector }) => selector.includes(`data-theme="${id}"`)), id);
});
for (const { selector, tokens } of palettes) {
  test(`${selector} satisfies WCAG AA normal text contrast on all semantic surfaces`, () => {
    const combinations = [
      ...['text', 'muted'].flatMap(fg => ['bg', 'surface', 'surface-2', 'surface-3'].map(bg => [fg, bg])),
      ['primary', 'primary-soft'], ['primary-strong', 'primary-soft'],
      ['on-primary', 'primary'], ['on-primary', 'primary-strong']
    ];
    for (const [fg, bg] of combinations) {
      const ratio = contrast(tokens[fg], tokens[bg]);
      assert.ok(ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)} < 4.5`);
    }
  });
}
