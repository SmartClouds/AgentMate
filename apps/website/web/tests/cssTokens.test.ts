import { describe, expect, it } from 'vitest';
import { readTokenBlock } from './cssTokens';

describe('readTokenBlock', () => {
  const css = `
    @import "tailwindcss";
    @custom-variant dark (&:where(.dark, .dark *));
    @theme inline { --color-a: hsl(var(--a)); }
    /* --ignored: 1; */
    :root,
    .theme-light { --a: 0 0% 4%; --b:  1  2; }
    .dark { --a: 1 1% 1%; }
    .dark.other { --a: 9; }
  `;

  it('reads the block whose selector list matches, in any order', () => {
    expect([...readTokenBlock(css, ['.theme-light', ':root'])]).toEqual([
      ['--a', '0 0% 4%'],
      ['--b', '1 2'],
    ]);
  });

  it('does not match a compound selector', () => {
    expect(readTokenBlock(css, ['.dark']).get('--a')).toBe('1 1% 1%');
  });

  it('reads an at-rule block that follows statements', () => {
    expect(readTokenBlock(css, ['@theme inline']).get('--color-a')).toBe('hsl(var(--a))');
  });

  it('returns an empty map when the rule is missing', () => {
    expect(readTokenBlock(css, ['.missing']).size).toBe(0);
  });
});
