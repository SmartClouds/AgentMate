import { describe, expect, it } from 'vitest';
import { loginTargetUrl, pageMatchesEntry } from './autofill.js';

describe('loginTargetUrl', () => {
  it('opens the first saved website, adding https to a bare host', () => {
    expect(loginTargetUrl(['github.com/login', 'https://gitlab.com'])).toBe(
      'https://github.com/login',
    );
  });

  it('skips blanks and anything that is not a web page', () => {
    expect(loginTargetUrl(['', 'ftp://files.example.com', 'http://router.local'])).toBe(
      'http://router.local/',
    );
  });

  it('is null when there is nowhere to go', () => {
    expect(loginTargetUrl([])).toBeNull();
    expect(loginTargetUrl(['javascript:alert(1)'])).toBeNull();
  });
});

describe('pageMatchesEntry', () => {
  const saved = ['https://github.com/login'];

  it('matches the saved host on any path, with or without www', () => {
    expect(pageMatchesEntry('https://github.com/session', saved)).toBe(true);
    expect(pageMatchesEntry('https://www.github.com/', saved)).toBe(true);
    expect(pageMatchesEntry('https://GitHub.com/', saved)).toBe(true);
  });

  it('matches a subdomain of the saved host', () => {
    expect(pageMatchesEntry('https://auth.github.com/sso', saved)).toBe(true);
  });

  it('refuses hosts that only look like the saved one', () => {
    expect(pageMatchesEntry('https://github.com.evil.io/login', saved)).toBe(false);
    expect(pageMatchesEntry('https://evilgithub.com/login', saved)).toBe(false);
    expect(pageMatchesEntry('https://github.co/login', saved)).toBe(false);
  });

  it('refuses a plain http page when the login was saved for https', () => {
    expect(pageMatchesEntry('http://github.com/login', saved)).toBe(false);
  });

  it('allows https when the login was saved for http', () => {
    expect(pageMatchesEntry('https://router.local/', ['http://router.local'])).toBe(true);
  });

  it('requires the same port when the saved website names one', () => {
    const local = ['http://localhost:3000/login'];
    expect(pageMatchesEntry('http://localhost:3000/', local)).toBe(true);
    expect(pageMatchesEntry('http://localhost:4000/', local)).toBe(false);
  });

  it('only matches an IP address exactly', () => {
    const ip = ['http://192.168.1.1'];
    expect(pageMatchesEntry('http://192.168.1.1/admin', ip)).toBe(true);
    expect(pageMatchesEntry('http://10.192.168.1.1/', ip)).toBe(false);
  });

  it('never treats a saved single label as a domain every site is under', () => {
    expect(pageMatchesEntry('https://example.com/', ['https://com'])).toBe(false);
    expect(pageMatchesEntry('https://com/', ['https://com'])).toBe(true);
  });

  it('refuses pages that are not on the web', () => {
    expect(pageMatchesEntry('file:///C:/login.html', saved)).toBe(false);
    expect(pageMatchesEntry('about:blank', saved)).toBe(false);
    expect(pageMatchesEntry('not a url', saved)).toBe(false);
  });

  it('matches any of several saved websites', () => {
    expect(pageMatchesEntry('https://gitlab.com/', ['github.com', 'gitlab.com'])).toBe(true);
  });

  it('matches nothing when no website is saved', () => {
    expect(pageMatchesEntry('https://github.com/', [])).toBe(false);
  });
});
