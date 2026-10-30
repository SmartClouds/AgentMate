import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFillScript } from './fillScript';
import { type FillOutcome, type LoginPage, startFill } from './fillSession';

/** A login page as main sees it: a URL, script injection, and load events. */
class FakePage extends EventEmitter implements LoginPage {
  url = 'about:blank';
  destroyed = false;
  scripts: string[] = [];
  /** What the injected script answers, one per call; the last one repeats. */
  answers: unknown[] = [{ username: true, password: true, submitted: false }];

  getURL(): string {
    return this.url;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  async executeJavaScript(code: string): Promise<unknown> {
    this.scripts.push(code);
    const answer = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    if (answer instanceof Error) throw answer;
    return answer;
  }
  load(url: string): void {
    this.url = url;
    this.emit('did-finish-load');
  }
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const CREDS = { username: 'octocat', password: 'S3cret!pw', submit: false };
const URLS = ['https://github.com/login'];

let page: FakePage;
let unlocked: boolean;
let outcomes: FillOutcome[];

function start(overrides: Partial<Parameters<typeof startFill>[0]> = {}) {
  return startFill({
    page,
    urls: URLS,
    creds: CREDS,
    isUnlocked: () => unlocked,
    onDone: (outcome) => outcomes.push(outcome),
    ...overrides,
  });
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  page = new FakePage();
  unlocked = true;
  outcomes = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildFillScript', () => {
  it('calls the filler with the document and the credentials', () => {
    const script = buildFillScript(CREDS);
    expect(script).toMatch(/^\(\/\*\*[\s\S]*function fillLoginForm\(doc, creds\)/);
    expect(script).toContain(
      '(document, {"username":"octocat","password":"S3cret!pw","submit":false})',
    );
  });

  it('keeps a password with quotes, backslashes and script tags inside its string', () => {
    const nasty = `a"b'c\\d</script><script>alert(1)</script>${LINE_SEPARATOR}e`;
    const script = buildFillScript({ ...CREDS, password: nasty });
    const args = script.slice(script.lastIndexOf('(document, ') + '(document, '.length, -1);
    expect(JSON.parse(args).password).toBe(nasty);
    expect(script).not.toContain('</script>');
    expect(script).not.toContain(LINE_SEPARATOR);
  });
});

describe('startFill', () => {
  it('fills once the login page has loaded, then stops', async () => {
    start();
    page.load('https://github.com/login');
    await flush();
    expect(page.scripts).toHaveLength(1);
    expect(page.scripts[0]).toContain('"S3cret!pw"');
    expect(outcomes).toEqual([{ result: 'filled', submitted: false, host: 'github.com' }]);

    page.load('https://github.com/dashboard');
    await flush();
    expect(page.scripts).toHaveLength(1);
  });

  it('fills a page that was already open when it started', async () => {
    page.url = 'https://github.com/login';
    start();
    await flush();
    expect(page.scripts).toHaveLength(1);
  });

  it('never fills a page on another host, even after a redirect', async () => {
    start();
    page.load('https://github.com.evil.io/login');
    await flush();
    page.load('http://github.com/login');
    await flush();
    expect(page.scripts).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  it('fills the password on the second step of a two step login, without the username again', async () => {
    page.answers = [
      { username: true, password: false, submitted: true },
      { username: false, password: true, submitted: true },
    ];
    start({ creds: { ...CREDS, submit: true } });
    page.load('https://github.com/login');
    await flush();
    expect(outcomes).toEqual([]);

    page.url = 'https://github.com/login/password';
    page.emit('did-navigate-in-page');
    await flush();
    expect(page.scripts).toHaveLength(2);
    expect(page.scripts[1]).toContain('"username":""');
    expect(outcomes).toEqual([{ result: 'filled', submitted: true, host: 'github.com' }]);
  });

  it('tries again for a form that a script draws after load', async () => {
    page.answers = [
      { username: false, password: false, submitted: false },
      { username: true, password: true, submitted: false },
    ];
    start();
    page.load('https://github.com/login');
    await flush();
    expect(page.scripts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(page.scripts).toHaveLength(2);
    expect(outcomes).toEqual([{ result: 'filled', submitted: false, host: 'github.com' }]);
  });

  it('gives up after a few tries and says it found no form', async () => {
    page.answers = [{ username: false, password: false, submitted: false }];
    start();
    page.load('https://github.com/login');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(page.scripts.length).toBe(6);
    expect(outcomes).toEqual([{ result: 'no-form', submitted: false, host: 'github.com' }]);
  });

  it('reports a username-only fill when the password step never comes', async () => {
    page.answers = [
      { username: true, password: false, submitted: false },
      { username: false, password: false, submitted: false },
    ];
    start();
    page.load('https://github.com/login');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcomes).toEqual([{ result: 'username-only', submitted: false, host: 'github.com' }]);
  });

  it('stops quietly when the vault locks before the page loads', async () => {
    start();
    unlocked = false;
    page.load('https://github.com/login');
    await flush();
    expect(page.scripts).toEqual([]);
    expect(outcomes).toEqual([]);
    expect(page.listenerCount('did-finish-load')).toBe(0);
  });

  it('stops quietly when the window closes', async () => {
    start();
    page.destroyed = true;
    page.emit('destroyed');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(outcomes).toEqual([]);
    expect(page.listenerCount('did-finish-load')).toBe(0);
  });

  it('gives up after two minutes without a matching page', async () => {
    start();
    page.load('https://example.com/');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(page.listenerCount('did-finish-load')).toBe(0);
    expect(outcomes).toEqual([]);
  });

  it('survives a page that throws from the script and tries again', async () => {
    page.answers = [
      new Error('Script failed to execute'),
      { username: true, password: true, submitted: false },
    ];
    start();
    page.load('https://github.com/login');
    await vi.advanceTimersByTimeAsync(1000);
    expect(outcomes).toEqual([{ result: 'filled', submitted: false, host: 'github.com' }]);
  });

  it('can be stopped by the caller', async () => {
    const stop = start();
    stop();
    page.load('https://github.com/login');
    await flush();
    expect(page.scripts).toEqual([]);
  });
});

describe('startFill clean up', () => {
  it('tells the owner it stopped, however it ends', async () => {
    const onStop = vi.fn();
    start({ onStop });
    page.destroyed = true;
    page.emit('destroyed');
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
