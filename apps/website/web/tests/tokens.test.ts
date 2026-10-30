import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readTokenBlock } from './cssTokens';

const appCss = readFileSync(
  fileURLToPath(new URL('../../../desktop/src/renderer/src/index.css', import.meta.url)),
  'utf8',
);
const siteCss = readFileSync(
  fileURLToPath(new URL('../src/styles/global.css', import.meta.url)),
  'utf8',
);

// Tokens the site adds on its own (design.md). The severity colors join the app in T024; once the
// app declares them, the comparison below covers them too.
const siteOnly = (name: string) =>
  name === '--glow' || name === '--grid-line' || name.startsWith('--severity-');

const themes = [
  { name: 'Light', selector: [':root', '.theme-light'] },
  { name: 'Dark', selector: ['.dark'] },
];

describe('design tokens match the desktop app', () => {
  const appLight = readTokenBlock(appCss, [':root', '.theme-light']);

  for (const theme of themes) {
    it(`declares every ${theme.name} token of the app with the same value`, () => {
      const app = new Map([...appLight, ...readTokenBlock(appCss, theme.selector)]);
      const site = new Map([
        ...readTokenBlock(siteCss, [':root', '.theme-light']),
        ...readTokenBlock(siteCss, theme.selector),
      ]);
      expect(app.size).toBeGreaterThan(20);
      for (const [name, value] of app) {
        expect(site.get(name), `${theme.name} ${name}`).toBe(value);
      }
    });

    it(`adds no ${theme.name} token the app does not have, except the site's own`, () => {
      const app = new Map([...appLight, ...readTokenBlock(appCss, theme.selector)]);
      const extra = [...readTokenBlock(siteCss, theme.selector).keys()].filter(
        (name) => !app.has(name) && !siteOnly(name),
      );
      expect(extra).toEqual([]);
    });
  }

  it('exposes the same Tailwind colors and radii as the app', () => {
    const app = readTokenBlock(appCss, ['@theme inline']);
    const site = readTokenBlock(siteCss, ['@theme inline']);
    for (const [name, value] of app) {
      expect(site.get(name), name).toBe(value);
    }
  });
});
