import { describe, expect, it } from 'vitest';
import { SNIPPET_LANGUAGES, snippetFor } from './snippets';

/**
 * The code a person pastes into their site after making a key. The front end gets the site key;
 * the back end reads the secret from an environment variable, so the secret never lands in code.
 */

const KEY = '6LcAbC-dEf_123';

describe('snippetFor', () => {
  it('loads the score script with the key and asks for a token on submit', () => {
    const html = snippetFor('html', { siteKey: KEY, type: 'score' });
    expect(html).toContain(`https://www.google.com/recaptcha/api.js?render=${KEY}`);
    expect(html).toContain(`grecaptcha.execute('${KEY}', { action: 'submit' })`);
    expect(html).toContain('g-recaptcha-response');
  });

  it('draws the checkbox for a checkbox key', () => {
    const html = snippetFor('html', { siteKey: KEY, type: 'checkbox' });
    expect(html).toContain('https://www.google.com/recaptcha/api.js"');
    expect(html).toContain(`<div class="g-recaptcha" data-sitekey="${KEY}"></div>`);
    expect(html).not.toContain('data-size="invisible"');
  });

  it('binds the submit button for an invisible key', () => {
    const html = snippetFor('html', { siteKey: KEY, type: 'invisible' });
    expect(html).toContain(`data-sitekey="${KEY}"`);
    expect(html).toContain('data-callback="onSubmit"');
    expect(html).toContain('class="g-recaptcha"');
  });

  it('gives React a component that loads the script once', () => {
    for (const type of ['score', 'checkbox', 'invisible'] as const) {
      const react = snippetFor('react', { siteKey: KEY, type });
      expect(react).toContain(KEY);
      expect(react).toContain('useEffect');
    }
    expect(snippetFor('react', { siteKey: KEY, type: 'checkbox' })).toContain('grecaptcha.render');
    expect(snippetFor('react', { siteKey: KEY, type: 'score' })).toContain('grecaptcha.execute');
  });

  it('checks the token on the server with the secret from the environment', () => {
    for (const language of ['php', 'node'] as const) {
      const code = snippetFor(language, { siteKey: KEY, type: 'checkbox' });
      expect(code).toContain('https://www.google.com/recaptcha/api/siteverify');
      expect(code).toContain('RECAPTCHA_SECRET');
      expect(code).not.toContain(KEY);
      expect(code).not.toMatch(/score/);
    }
  });

  it('also checks the score and action for a score key', () => {
    expect(snippetFor('php', { siteKey: KEY, type: 'score' })).toMatch(
      /\['score'\] \?\? 0\) >= 0\.5/,
    );
    expect(snippetFor('node', { siteKey: KEY, type: 'score' })).toMatch(/score >= 0\.5/);
    expect(snippetFor('node', { siteKey: KEY, type: 'score' })).toContain("action === 'submit'");
  });

  it('refuses a site key that could break out of the code', () => {
    expect(() => snippetFor('html', { siteKey: `x" onload="alert(1)`, type: 'score' })).toThrow(
      /site key/,
    );
  });

  it('lists every language with a label', () => {
    expect(SNIPPET_LANGUAGES.map((language) => language.id)).toEqual([
      'html',
      'react',
      'php',
      'node',
    ]);
    for (const language of SNIPPET_LANGUAGES) expect(language.label).toBeTruthy();
  });
});
