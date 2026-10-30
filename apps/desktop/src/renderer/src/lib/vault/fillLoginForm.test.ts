import source from '@shared/vault/fillLoginForm.js?raw';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * One-click login fills a page by running this script string in it through executeJavaScript.
 * These tests run the same string against forms built in jsdom, the way a site would lay them out.
 */

interface FillResult {
  username: boolean;
  password: boolean;
  submitted: boolean;
}

type Fill = (
  doc: Document,
  creds: { username: string; password: string; submit: boolean },
) => FillResult;

const fill: Fill = (0, eval)(source.trim().replace(/;\s*$/, ''));

function page(html: string): void {
  document.body.innerHTML = html;
}

const input = (selector: string) => document.querySelector(selector) as HTMLInputElement;

const CREDS = { username: 'octocat', password: 'S3cret!pw', submit: false };

afterEach(() => {
  document.body.innerHTML = '';
});

describe('fillLoginForm', () => {
  it('fills the username and password of a plain login form', () => {
    page(`
      <form>
        <input name="login" type="text">
        <input name="password" type="password">
        <button type="submit">Sign in</button>
      </form>`);
    expect(fill(document, CREDS)).toEqual({ username: true, password: true, submitted: false });
    expect(input('[name=login]').value).toBe('octocat');
    expect(input('[name=password]').value).toBe('S3cret!pw');
  });

  it('tells the page about the new values, so React and Vue forms pick them up', () => {
    page('<form><input type="email" id="email"><input type="password" id="pw"></form>');
    const seen: string[] = [];
    for (const el of document.querySelectorAll('input')) {
      el.addEventListener('input', () => seen.push(`input:${el.id}`));
      el.addEventListener('change', () => seen.push(`change:${el.id}`));
    }
    fill(document, CREDS);
    expect(seen).toEqual(['input:email', 'change:email', 'input:pw', 'change:pw']);
  });

  it('sets the value past a framework that overrides the value property', () => {
    page('<form><input id="user"><input type="password" id="pw"></form>');
    const user = input('#user');
    // React tracks the last value it saw through an own property on the element.
    let tracked = '';
    Object.defineProperty(user, 'value', {
      configurable: true,
      get: () => tracked,
      set: (value: string) => {
        tracked = `tracked:${value}`;
      },
    });
    fill(document, CREDS);
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    expect(native?.get?.call(user)).toBe('octocat');
  });

  it('prefers the field marked as the username over other text fields', () => {
    page(`
      <form>
        <input name="company">
        <input name="who" autocomplete="username">
        <input type="password">
      </form>`);
    fill(document, CREDS);
    expect(input('[name=who]').value).toBe('octocat');
    expect(input('[name=company]').value).toBe('');
  });

  it('skips hidden decoys, honeypots and disabled fields', () => {
    page(`
      <form>
        <input name="trap" style="display:none">
        <div hidden><input name="hidden-user"><input type="password" name="hidden-pw"></div>
        <input type="hidden" name="csrf" value="token">
        <input name="email" type="email">
        <input type="password" name="disabled-pw" disabled>
        <input type="password" name="pw">
      </form>`);
    fill(document, CREDS);
    expect(input('[name=email]').value).toBe('octocat');
    expect(input('[name=pw]').value).toBe('S3cret!pw');
    expect(input('[name=trap]').value).toBe('');
    expect(input('[name=hidden-user]').value).toBe('');
    expect(input('[name=hidden-pw]').value).toBe('');
    expect(input('[name=csrf]').value).toBe('token');
  });

  it('fills only the username on the first step of a two step login', () => {
    page(`
      <form>
        <input type="email" name="identifier" placeholder="Email or phone">
        <button type="button">Next</button>
      </form>`);
    expect(fill(document, CREDS)).toEqual({ username: true, password: false, submitted: false });
    expect(input('[name=identifier]').value).toBe('octocat');
  });

  it('leaves a lone search box alone', () => {
    page('<form><input type="search" name="q"><input name="query"></form>');
    expect(fill(document, CREDS)).toEqual({ username: false, password: false, submitted: false });
    expect(input('[name=q]').value).toBe('');
    expect(input('[name=query]').value).toBe('');
  });

  it('fills the password alone on the second step', () => {
    page('<form><input type="password" name="pw"><button>Sign in</button></form>');
    expect(fill(document, CREDS)).toEqual({ username: false, password: true, submitted: false });
  });

  it('only fills the sign-in password on a page that also asks for a new one', () => {
    page(`
      <form>
        <input name="user">
        <input type="password" name="new" autocomplete="new-password">
        <input type="password" name="current" autocomplete="current-password">
      </form>`);
    fill(document, CREDS);
    expect(input('[name=current]').value).toBe('S3cret!pw');
    expect(input('[name=new]').value).toBe('');
  });

  it('presses the sign-in button when asked to submit', () => {
    page(`
      <form>
        <input name="user"><input type="password" name="pw">
        <button type="button">Forgot password?</button>
        <button type="submit">Log in</button>
      </form>`);
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')?.addEventListener('submit', onSubmit);
    expect(fill(document, { ...CREDS, submit: true })).toEqual({
      username: true,
      password: true,
      submitted: true,
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('clicks a sign-in button that is not a form submit, as single page apps use', () => {
    page(`
      <div>
        <input name="user"><input type="password" name="pw">
        <div role="button" id="go">Sign in</div>
      </div>`);
    const onClick = vi.fn();
    document.getElementById('go')?.addEventListener('click', onClick);
    expect(fill(document, { ...CREDS, submit: true }).submitted).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('presses next on the first step of a two step login when submitting', () => {
    page(`
      <form>
        <input type="email" name="email">
        <button type="button" id="next">Next</button>
      </form>`);
    const onClick = vi.fn();
    document.getElementById('next')?.addEventListener('click', onClick);
    expect(fill(document, { ...CREDS, submit: true }).submitted).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a page with no login form', () => {
    page('<main><h1>Welcome back</h1><a href="/logout">Log out</a></main>');
    expect(fill(document, { ...CREDS, submit: true })).toEqual({
      username: false,
      password: false,
      submitted: false,
    });
  });

  it('skips an empty username instead of clearing the field', () => {
    page('<form><input name="user" value="kept"><input type="password" name="pw"></form>');
    expect(fill(document, { ...CREDS, username: '' }).username).toBe(false);
    expect(input('[name=user]').value).toBe('kept');
  });
});
