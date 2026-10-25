import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readStyleReference } from '../node/scenes/assets.js';
import { STYLE_PRESETS } from './presets.js';

/**
 * Every style has a reference scene of its own (`assets/styles/<id>/`), which the gallery plays and
 * the AI sees as an example. These are the rules a scene must keep to pass its check, read from the
 * source; the frame-by-frame check itself runs in a real browser (studioScenes.e2e.ts).
 */

describe('reference scenes', () => {
  it.each(STYLE_PRESETS.map((s) => [s.id]))(
    '%s registers a scene and keeps to the scene rules',
    async (id) => {
      const files = await readStyleReference(id);
      expect(files.map((f) => f.path)).toContain('index.html');
      const text = files.map((f) => Buffer.from(f.content).toString('utf8')).join('\n');
      expect(text).toContain('Studio.scene(');
      // No network, no real clock, no unseeded randomness.
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
      expect(text).not.toMatch(/Date\.now|performance\.now|new Date\(\)/);
      expect(text).not.toMatch(/Math\.random/);
      // Persian and English copy, chosen by the video's language.
      expect(text).toMatch(/fa:/);
      expect(text).toMatch(/en:/);
      expect(text).toMatch(/\.lang = ctx\.lang|lang="\$\{ctx\.lang\}"/);
    },
  );

  it('refuses a name that is not a style', async () => {
    await expect(readStyleReference('../fonts')).rejects.toThrow(/not a style/);
  });

  it('ships the fonts every scene may name', async () => {
    const css = await readFile(new URL('../../assets/fonts/fonts.css', import.meta.url), 'utf8');
    for (const family of ['Vazirmatn', 'Inter', 'Noto Naskh Arabic'])
      expect(css).toContain(`'${family}'`);
  });
});
