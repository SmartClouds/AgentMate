import type {
  TurnstileClearance,
  TurnstileMode,
  TurnstileRegion,
  TurnstileWidgetInput,
} from '../cloudflareTypes';
import { validateDomains } from '../recaptcha/domains';

/**
 * Turnstile, Cloudflare's captcha. Widgets belong to the account rather than to a zone, so the
 * zone's tab shows the ones that cover it. The dialog checks a widget with this as the user types,
 * and the main process checks it again before it goes to Cloudflare.
 */

/** Cloudflare's limit per widget on the Free and Pro plans. */
export const MAX_TURNSTILE_DOMAINS = 10;

/** Cloudflare's limit on a widget's name. */
export const MAX_TURNSTILE_NAME = 254;

export const TURNSTILE_MODES: readonly TurnstileMode[] = [
  'managed',
  'non-interactive',
  'invisible',
];

export const TURNSTILE_CLEARANCES: readonly TurnstileClearance[] = [
  'no_clearance',
  'jschallenge',
  'managed',
  'interactive',
];

export const TURNSTILE_REGIONS: readonly TurnstileRegion[] = ['world', 'china'];

// A real site key starts with 0x, a test key with 1x, 2x or 3x.
const SITEKEY = /^[0-9]x[A-Za-z0-9_-]{8,64}$/;

export function isTurnstileSitekey(value: unknown): value is string {
  return typeof value === 'string' && SITEKEY.test(value);
}

/** Whether a widget lists the zone itself or one of its subdomains. */
export function widgetCoversZone(
  widget: { domains: readonly string[] },
  zoneName: string,
): boolean {
  const zone = zoneName.toLowerCase();
  return widget.domains.some((domain) => {
    const name = domain.toLowerCase();
    return name === zone || name.endsWith(`.${zone}`);
  });
}

/** The first problem with a widget, in words, or null when Cloudflare can take it. */
export function validateTurnstileInput(input: TurnstileWidgetInput): string | null {
  const name = input.name.trim();
  if (!name) return 'Give the widget a name.';
  if (name.length > MAX_TURNSTILE_NAME) {
    return `Keep the name to ${MAX_TURNSTILE_NAME} characters or fewer.`;
  }
  const domains = validateDomains(input.domains, MAX_TURNSTILE_DOMAINS, 'A widget');
  if (domains) return domains;
  if (!TURNSTILE_MODES.includes(input.mode)) return 'Pick a widget mode.';
  if (!TURNSTILE_CLEARANCES.includes(input.clearance)) return 'Pick a pre-clearance level.';
  if (!TURNSTILE_REGIONS.includes(input.region)) return 'Pick a region.';
  return null;
}

export interface TurnstileTestKey {
  value: string;
  /** What Cloudflare does with it. */
  effect: string;
}

/**
 * Cloudflare's dummy keys, for trying a form on localhost or in automated tests. A test site key
 * only works with a test secret, and the other way round.
 */
export const TURNSTILE_TEST_SITE_KEYS: readonly TurnstileTestKey[] = [
  { value: '1x00000000000000000000AA', effect: 'Always passes (visible)' },
  { value: '2x00000000000000000000AB', effect: 'Always blocks (visible)' },
  { value: '1x00000000000000000000BB', effect: 'Always passes (invisible)' },
  { value: '2x00000000000000000000BB', effect: 'Always blocks (invisible)' },
  { value: '3x00000000000000000000FF', effect: 'Always asks the visitor to click (visible)' },
];

export const TURNSTILE_TEST_SECRETS: readonly TurnstileTestKey[] = [
  { value: '1x0000000000000000000000000000000AA', effect: 'Always passes' },
  { value: '2x0000000000000000000000000000000AA', effect: 'Always fails' },
  { value: '3x0000000000000000000000000000000AA', effect: 'Says the token was already used' },
];
