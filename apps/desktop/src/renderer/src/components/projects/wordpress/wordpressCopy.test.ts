import { describe, expect, it } from 'vitest';
import {
  deployOutcome,
  isAgentPath,
  joinFolder,
  parseSyntaxErrors,
  planExpired,
  slugifyProjectName,
} from './wordpressCopy';

describe('wordpressCopy', () => {
  it('reads a plan expiry in milliseconds, and in seconds if that is what came', () => {
    const now = 1_760_000_000_000;
    expect(planExpired(now + 60_000, now)).toBe(false);
    expect(planExpired(now - 1, now)).toBe(true);
    expect(planExpired(now / 1000 + 60, now)).toBe(false);
    expect(planExpired(now / 1000 - 60, now)).toBe(true);
  });

  it('turns a project name into a folder name', () => {
    expect(slugifyProjectName('Acme Shop')).toBe('acme-shop');
    expect(slugifyProjectName('  Café / Bar!! ')).toBe('cafe-bar');
    expect(slugifyProjectName('***')).toBe('wordpress-site');
  });

  it('joins with the separator the folder already uses', () => {
    expect(joinFolder('D:\\Sites\\', 'acme')).toBe('D:\\Sites\\acme');
    expect(joinFolder('/home/me/sites/', 'acme')).toBe('/home/me/sites/acme');
  });

  it('pulls the file and line out of a syntax error message', () => {
    const parsed = parseSyntaxErrors(
      "2 PHP files have syntax errors.\nwp-content/themes/a/functions.php:12: unexpected '}'\nwp-content/plugins/b/b.php:3: unexpected end of file",
    );
    expect(parsed.summary).toBe('2 PHP files have syntax errors.');
    expect(parsed.issues).toEqual([
      { path: 'wp-content/themes/a/functions.php', line: 12, message: "unexpected '}'" },
      { path: 'wp-content/plugins/b/b.php', line: 3, message: 'unexpected end of file' },
    ]);
    expect(parseSyntaxErrors('Something else went wrong.')).toEqual({
      summary: 'Something else went wrong.',
      issues: [],
    });
  });

  it('knows agent paths from version control and secrets', () => {
    expect(isAgentPath('.claude/settings.json')).toBe(true);
    expect(isAgentPath('inc/AGENTS.md')).toBe(true);
    expect(isAgentPath('.runova/x')).toBe(true);
    expect(isAgentPath('.git/HEAD')).toBe(false);
    expect(isAgentPath('.env')).toBe(false);
    expect(isAgentPath('style.css')).toBe(false);
  });

  it('words every way a deploy can end', () => {
    const base = { deployId: 'd', health: [], uploaded: 1, deleted: 0, durationMs: 1 };
    expect(deployOutcome({ ...base, state: 'done' }).detail).toMatch(/^1 file uploaded, 0 files/);
    expect(deployOutcome({ ...base, state: 'rolledBack', reason: 'fatalError' }).detail).toMatch(
      /PHP fatal error/,
    );
    expect(deployOutcome({ ...base, state: 'rolledBack', reason: 'notConfirmed' }).detail).toMatch(
      /on its own/,
    );
    expect(deployOutcome({ ...base, state: 'rolledBack' }).title).toBe('Rolled back');
    expect(deployOutcome({ ...base, state: 'aborted' }).title).toBe('Stopped');
    expect(deployOutcome({ ...base, state: 'expired' }).title).toBe('Expired');
    expect(deployOutcome({ ...base, state: 'applying' }).tone).toBe('error');
  });
});
