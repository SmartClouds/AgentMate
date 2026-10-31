import { describe, expect, it } from 'vitest';
import type { TurnstileWidgetInput } from '../cloudflareTypes';
import {
  isTurnstileSitekey,
  MAX_TURNSTILE_DOMAINS,
  TURNSTILE_TEST_SECRETS,
  TURNSTILE_TEST_SITE_KEYS,
  validateTurnstileInput,
  widgetCoversZone,
} from './turnstile';

/**
 * Turnstile widgets belong to a Cloudflare account, not to a zone, so the zone's tab picks out the
 * ones that list the zone or one of its subdomains. What goes to Cloudflare is checked here first,
 * by the dialog as the user types and again by the main process.
 */

const INPUT: TurnstileWidgetInput = {
  name: 'Contact form',
  domains: ['example.com'],
  mode: 'managed',
  clearance: 'no_clearance',
  region: 'world',
  offlabel: false,
  ephemeralId: false,
};

describe('widgetCoversZone', () => {
  it('matches the zone itself and any subdomain of it', () => {
    expect(widgetCoversZone({ domains: ['example.com'] }, 'example.com')).toBe(true);
    expect(widgetCoversZone({ domains: ['shop.example.com'] }, 'example.com')).toBe(true);
    expect(widgetCoversZone({ domains: ['other.io', 'a.b.example.com'] }, 'example.com')).toBe(
      true,
    );
  });

  it('does not match a name that only ends the same way', () => {
    expect(widgetCoversZone({ domains: ['notexample.com'] }, 'example.com')).toBe(false);
    expect(widgetCoversZone({ domains: ['example.com.au'] }, 'example.com')).toBe(false);
    expect(widgetCoversZone({ domains: [] }, 'example.com')).toBe(false);
  });

  it('ignores case on both sides', () => {
    expect(widgetCoversZone({ domains: ['WWW.Example.com'] }, 'example.COM')).toBe(true);
  });
});

describe('validateTurnstileInput', () => {
  it('lets a complete widget through', () => {
    expect(validateTurnstileInput(INPUT)).toBeNull();
    expect(
      validateTurnstileInput({ ...INPUT, mode: 'invisible', clearance: 'interactive' }),
    ).toBeNull();
  });

  it('wants a name of at most 254 characters', () => {
    expect(validateTurnstileInput({ ...INPUT, name: '  ' })).toMatch(/name/i);
    expect(validateTurnstileInput({ ...INPUT, name: 'x'.repeat(255) })).toMatch(/254/);
    expect(validateTurnstileInput({ ...INPUT, name: 'x'.repeat(254) })).toBeNull();
  });

  it(`takes 1 to ${MAX_TURNSTILE_DOMAINS} bare domains`, () => {
    expect(validateTurnstileInput({ ...INPUT, domains: [] })).toMatch(/at least one/);
    const many = Array.from({ length: MAX_TURNSTILE_DOMAINS + 1 }, (_, i) => `s${i}.example.com`);
    expect(validateTurnstileInput({ ...INPUT, domains: many })).toMatch(
      new RegExp(`at most ${MAX_TURNSTILE_DOMAINS}`),
    );
    expect(validateTurnstileInput({ ...INPUT, domains: ['https://example.com/x'] })).toMatch(
      /bare domain/,
    );
    expect(validateTurnstileInput({ ...INPUT, domains: ['localhost'] })).toBeNull();
  });

  it('refuses a mode, pre-clearance or region Cloudflare does not know', () => {
    expect(validateTurnstileInput({ ...INPUT, mode: 'loud' as never })).toMatch(/mode/i);
    expect(validateTurnstileInput({ ...INPUT, clearance: 'all' as never })).toMatch(/clearance/i);
    expect(validateTurnstileInput({ ...INPUT, region: 'mars' as never })).toMatch(/region/i);
  });
});

describe('isTurnstileSitekey', () => {
  it('knows a real and a test site key', () => {
    expect(isTurnstileSitekey('0x4AAAAAAABkMYinukE8nzY')).toBe(true);
    expect(isTurnstileSitekey('1x00000000000000000000AA')).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isTurnstileSitekey('')).toBe(false);
    expect(isTurnstileSitekey('6LcAbC-dEf_123')).toBe(false);
    expect(isTurnstileSitekey('0x"><script>')).toBe(false);
    expect(isTurnstileSitekey(`0x${'a'.repeat(80)}`)).toBe(false);
  });
});

describe('the test keys', () => {
  it("lists Cloudflare's dummy site keys and secrets exactly", () => {
    expect(TURNSTILE_TEST_SITE_KEYS.map((key) => key.value)).toEqual([
      '1x00000000000000000000AA',
      '2x00000000000000000000AB',
      '1x00000000000000000000BB',
      '2x00000000000000000000BB',
      '3x00000000000000000000FF',
    ]);
    expect(TURNSTILE_TEST_SECRETS.map((key) => key.value)).toEqual([
      '1x0000000000000000000000000000000AA',
      '2x0000000000000000000000000000000AA',
      '3x0000000000000000000000000000000AA',
    ]);
    for (const key of TURNSTILE_TEST_SITE_KEYS) expect(isTurnstileSitekey(key.value)).toBe(true);
  });
});
