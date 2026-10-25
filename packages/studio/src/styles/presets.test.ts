import { describe, expect, it } from 'vitest';
import { ASPECTS } from '../document/schema.js';
import { STYLE_PRESETS, styleById } from './presets.js';

describe('STYLE_PRESETS', () => {
  it('has fifteen styles with unique ids', () => {
    expect(STYLE_PRESETS).toHaveLength(15);
    expect(new Set(STYLE_PRESETS.map((s) => s.id)).size).toBe(15);
  });

  it('gives every style a usable palette, guidance and formats', () => {
    for (const style of STYLE_PRESETS) {
      expect(style.id).toMatch(/^[a-z0-9-]+$/);
      expect(style.palette.length).toBeGreaterThanOrEqual(3);
      for (const color of style.palette) expect(color).toMatch(/^#[0-9A-F]{6}$/);
      expect(style.dos.length).toBeGreaterThan(0);
      expect(style.donts.length).toBeGreaterThan(0);
      expect(style.formats.length).toBeGreaterThan(0);
      for (const format of style.formats) expect(ASPECTS).toContain(format);
      expect(style.fonts.arabic).toMatch(/Vazirmatn|Naskh/);
    }
  });

  it('finds a style by id', () => {
    expect(styleById('bauhaus')?.name).toBe('Bauhaus');
    expect(styleById('nope')).toBeUndefined();
    expect(styleById(null)).toBeUndefined();
  });
});
