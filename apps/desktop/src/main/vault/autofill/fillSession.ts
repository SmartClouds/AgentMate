import { hostOf, pageMatchesEntry } from '@runova/core';
import { buildFillScript, type FillCredentials, isFillResult } from './fillScript';

/** The parts of a webContents a fill needs, so tests can stand in for a real page. */
export interface LoginPage {
  getURL(): string;
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
  on(
    event: 'did-finish-load' | 'did-navigate-in-page' | 'destroyed',
    listener: () => void,
  ): unknown;
  removeListener(
    event: 'did-finish-load' | 'did-navigate-in-page' | 'destroyed',
    listener: () => void,
  ): unknown;
}

/** How a fill ended, for the toast. A fill that was cancelled reports nothing. */
export interface FillOutcome {
  result: 'filled' | 'username-only' | 'no-form';
  submitted: boolean;
  host: string;
}

export interface FillOptions {
  page: LoginPage;
  /** The entry's saved websites. Only pages on these hosts are ever filled. */
  urls: readonly string[];
  creds: FillCredentials;
  isUnlocked: () => boolean;
  onDone: (outcome: FillOutcome) => void;
  /** Called once however the fill ends, cancelled ones included. */
  onStop?: () => void;
  /** Tries per fill, counting retries for forms that a script draws late. */
  maxAttempts?: number;
  retryMs?: number;
  timeoutMs?: number;
}

/**
 * Fills one entry into one page. It waits for the page to load, fills it when it is on one of
 * the entry's hosts, and follows a two step login to the password page. The credentials live in
 * this closure only, and are dropped when it stops: after the password is in, after a few tries,
 * after two minutes, when the page closes or when the vault locks. Returns a function to stop it.
 */
export function startFill({
  page,
  urls,
  creds,
  isUnlocked,
  onDone,
  onStop,
  maxAttempts = 6,
  retryMs = 1000,
  timeoutMs = 120_000,
}: FillOptions): () => void {
  let pending: FillCredentials | null = { ...creds };
  let attempts = 0;
  let usernameFilled = false;
  let submitted = false;
  let host = '';
  let busy = false;
  let again = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const stop = (outcome?: FillOutcome['result']): void => {
    if (!pending) return;
    pending = null;
    if (retry) clearTimeout(retry);
    clearTimeout(deadline);
    page.removeListener('did-finish-load', attempt);
    page.removeListener('did-navigate-in-page', attempt);
    page.removeListener('destroyed', cancel);
    onStop?.();
    if (outcome) onDone({ result: outcome, submitted, host });
  };
  const cancel = (): void => stop();

  async function attempt(): Promise<void> {
    if (!pending) return;
    if (busy) {
      again = true;
      return;
    }
    if (!isUnlocked() || page.isDestroyed()) {
      stop();
      return;
    }
    const url = page.getURL();
    if (!pageMatchesEntry(url, urls)) return;
    host = hostOf(url);
    if (retry) clearTimeout(retry);
    retry = null;
    attempts += 1;
    busy = true;

    let result = null;
    try {
      // Once the username is in, the next pages only need the password.
      const answer = await page.executeJavaScript(
        buildFillScript({ ...pending, username: usernameFilled ? '' : pending.username }),
      );
      if (isFillResult(answer)) result = answer;
    } catch {
      // The page navigated away mid-script or refused it; the next load or retry tries again.
    } finally {
      busy = false;
    }
    if (!pending) return;

    if (result?.username) usernameFilled = true;
    if (result?.submitted) submitted = true;
    if (result?.password) {
      stop('filled');
      return;
    }
    if (attempts >= maxAttempts) {
      stop(usernameFilled ? 'username-only' : 'no-form');
      return;
    }
    if (again) {
      again = false;
      void attempt();
      return;
    }
    retry = setTimeout(() => void attempt(), retryMs);
  }

  const deadline = setTimeout(() => stop(attempts > 0 ? 'no-form' : undefined), timeoutMs);
  page.on('did-finish-load', attempt);
  page.on('did-navigate-in-page', attempt);
  page.on('destroyed', cancel);
  // A page that is already open, such as a workspace tab, gets its first try straight away.
  queueMicrotask(() => {
    if (attempts === 0 && !busy) void attempt();
  });
  return () => stop();
}
