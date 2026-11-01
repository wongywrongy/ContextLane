import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../apps/web/src/styles/app.css', import.meta.url), 'utf8');
const read = selector => Object.fromEntries([...css.match(selector)[1].matchAll(/(--[\w-]+):\s*(#[a-f0-9]{6})/gi)].map(m => [m[1], m[2]]));
const dark = read(/:root\s*\{([^}]+)\}/), light = { ...dark, ...read(/:root\[data-theme="light"\]\s*\{([^}]+)\}/) };
const luminance = hex => hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
let checked = 0;
for (const [theme, tokens] of [['dark', dark], ['light', light]]) {
  const check = (ink, bg) => { const ratio = contrast(tokens[ink], tokens[bg]); assert.ok(ratio >= 4.5, `${theme} ${ink} on ${bg}: ${ratio.toFixed(2)}`); checked++; };
  for (const ink of ['--ink', '--text', '--text-2', '--muted', '--faint-ink', '--accent', '--you-ink', '--ok-ink', '--bad-ink', '--think', '--lc1', '--lc2', '--lc3', '--lc4', '--lc5', '--lc6']) for (const bg of ['--surface', '--surface-2']) check(ink, bg);
  for (let i = 1; i <= 6; i++) check('--lane-ink', `--lc${i}`);
  check('--button-ink', '--accent'); check('--you-ink', '--you-bg');
}
console.log(`${checked} dark/light text token pairs pass WCAG AA (4.5:1). Decorative faint is not a text token.`);
