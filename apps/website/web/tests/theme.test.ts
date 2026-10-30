import { describe, expect, it } from 'vitest';
import { resolveTheme, THEME_STORAGE_KEY, themeInitScript } from '../src/lib/theme';

describe('resolveTheme', () => {
  it('uses the stored choice first', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('follows prefers-color-scheme when nothing is stored', () => {
    expect(resolveTheme(null, true)).toBe('light');
    expect(resolveTheme(null, false)).toBe('dark');
  });

  it('ignores a stored value it does not know', () => {
    expect(resolveTheme('sepia', false)).toBe('dark');
  });
});

describe('themeInitScript', () => {
  function run(stored: string | null, prefersLight: boolean, throws = false) {
    const classes = new Set(['dark']);
    const document = {
      documentElement: {
        classList: {
          toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
        },
        style: {} as Record<string, string>,
      },
    };
    const localStorage = {
      getItem: (key: string) => {
        if (throws) throw new Error('blocked');
        return key === THEME_STORAGE_KEY ? stored : null;
      },
    };
    const matchMedia = (query: string) => ({
      matches: query === '(prefers-color-scheme: light)' && prefersLight,
    });
    new Function('document', 'localStorage', 'matchMedia', themeInitScript)(
      document,
      localStorage,
      matchMedia,
    );
    return { dark: classes.has('dark'), scheme: document.documentElement.style.colorScheme };
  }

  it('keeps Dark by default', () => {
    expect(run(null, false)).toEqual({ dark: true, scheme: 'dark' });
  });

  it('switches to Light for a light system preference or a stored choice', () => {
    expect(run(null, true)).toEqual({ dark: false, scheme: 'light' });
    expect(run('light', false)).toEqual({ dark: false, scheme: 'light' });
  });

  it('still follows the system when storage is blocked', () => {
    expect(run(null, true, true)).toEqual({ dark: false, scheme: 'light' });
  });
});
