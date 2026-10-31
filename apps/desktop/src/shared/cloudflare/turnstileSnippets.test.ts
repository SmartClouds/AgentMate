import { describe, expect, it } from 'vitest';
import { SNIPPET_LANGUAGES } from '../recaptcha/snippets';
import { turnstileSnippetFor } from './turnstileSnippets';

/**
 * The code a person pastes into their site for a Turnstile widget. The page side gets the site
 * key; the server side reads the secret from TURNSTILE_SECRET, so it never lands in code.
 */

const KEY = '0x4AAAAAAABkMYinukE8nzY';
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

describe('turnstileSnippetFor', () => {
  it('loads the script and draws the widget inside the form', () => {
    const html = turnstileSnippetFor('html', KEY);
    expect(html).toContain(`<script src="${SCRIPT}" async defer></script>`);
    expect(html).toContain(`<div class="cf-turnstile" data-sitekey="${KEY}"></div>`);
    expect(html).toContain('<form');
  });

  it('gives React a component that renders the widget and removes it again', () => {
    const react = turnstileSnippetFor('react', KEY);
    expect(react).toContain(`const SITE_KEY = '${KEY}'`);
    expect(react).toContain(`${SCRIPT}?render=explicit`);
    expect(react).toContain('turnstile.render');
    expect(react).toContain('turnstile.remove');
    expect(react).toContain('useEffect');
  });

  it('checks the token on the server with the secret from the environment', () => {
    for (const language of ['php', 'node'] as const) {
      const code = turnstileSnippetFor(language, KEY);
      expect(code).toContain(VERIFY);
      expect(code).toContain('TURNSTILE_SECRET');
      expect(code).not.toContain(KEY);
    }
    expect(turnstileSnippetFor('php', KEY)).toContain("$_POST['cf-turnstile-response']");
    expect(turnstileSnippetFor('node', KEY)).toContain('result.success === true');
  });

  it('has code for every language the picker offers', () => {
    for (const language of SNIPPET_LANGUAGES) {
      expect(turnstileSnippetFor(language.id, KEY).length).toBeGreaterThan(50);
    }
  });

  it('refuses something that is not a site key, so nothing odd lands in the code', () => {
    expect(() => turnstileSnippetFor('html', '"><script>alert(1)</script>')).toThrow(/site key/);
  });
});
