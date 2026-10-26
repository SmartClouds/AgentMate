import { describe, expect, it } from 'vitest';
import type { OpenSessionSummary } from './apiTypes';
import {
  describeOpenSessions,
  hasOpenSessions,
  QUIT_CONFIRM_LABEL,
  QUIT_CONFIRM_TITLE,
} from './quitConfirmation';

/**
 * The same text goes into the in-app dialog and the native message box main
 * shows when the window is already gone, so the wording is worth pinning: it is
 * the last thing a user reads before losing a running agent session.
 */

function summary(over: Partial<OpenSessionSummary> = {}): OpenSessionSummary {
  return { clis: 0, ssh: 0, rdp: 0, clisKeepRunning: false, ...over };
}

describe('hasOpenSessions', () => {
  it('is false only when nothing at all is open', () => {
    expect(hasOpenSessions(summary())).toBe(false);
    // clisKeepRunning on its own must not make the app ask: there is nothing
    // to warn about.
    expect(hasOpenSessions(summary({ clisKeepRunning: true }))).toBe(false);
  });

  it('is true for any one kind of session', () => {
    expect(hasOpenSessions(summary({ clis: 1 }))).toBe(true);
    expect(hasOpenSessions(summary({ ssh: 1 }))).toBe(true);
    expect(hasOpenSessions(summary({ rdp: 1 }))).toBe(true);
  });
});

describe('describeOpenSessions', () => {
  it('uses the singular for one session and the plural for more', () => {
    expect(describeOpenSessions(summary({ clis: 1 }))).toContain('1 CLI session open');
    expect(describeOpenSessions(summary({ clis: 2 }))).toContain('2 CLI sessions open');
    expect(describeOpenSessions(summary({ ssh: 1 }))).toContain('1 SSH connection open');
    expect(describeOpenSessions(summary({ ssh: 3 }))).toContain('3 SSH connections open');
    expect(describeOpenSessions(summary({ rdp: 1 }))).toContain('1 Remote Desktop session open');
    expect(describeOpenSessions(summary({ rdp: 2 }))).toContain('2 Remote Desktop sessions open');
  });

  it('leaves out the kinds that have nothing open', () => {
    const text = describeOpenSessions(summary({ ssh: 1 }));
    expect(text).not.toContain('CLI');
    expect(text).not.toContain('Remote Desktop');
  });

  it('joins two kinds with "and" and three with commas plus "and"', () => {
    expect(describeOpenSessions(summary({ clis: 1, ssh: 1 }))).toContain(
      '1 CLI session and 1 SSH connection open',
    );
    expect(describeOpenSessions(summary({ clis: 2, ssh: 1, rdp: 1 }))).toContain(
      '2 CLI sessions, 1 SSH connection and 1 Remote Desktop session open',
    );
  });

  it('says CLIs keep running when the background terminal host holds them', () => {
    // This is the reassuring case: closing the app is not destructive, so the
    // dialog should not imply it is.
    const text = describeOpenSessions(summary({ clis: 2, clisKeepRunning: true }));
    expect(text).toContain('leaves them running in the background');
    expect(text).not.toContain('stops');
  });

  it('uses "it" for a single session and "them" for several', () => {
    expect(describeOpenSessions(summary({ clis: 1, clisKeepRunning: true }))).toContain(
      'leaves it running',
    );
    expect(describeOpenSessions(summary({ clis: 1 }))).toContain('Closing the app stops it.');
    expect(describeOpenSessions(summary({ clis: 2 }))).toContain('Closing the app stops them.');
  });

  it('warns that servers drop even when the CLIs survive', () => {
    // Mixed case: the CLI half is safe, the server half is not, so the promise
    // about the background must not be repeated here.
    const text = describeOpenSessions(summary({ clis: 1, ssh: 1, clisKeepRunning: true }));
    expect(text).toContain('CLI sessions keep running in the background');
    expect(text).toContain('server connections will be closed');
  });

  it('says both stop when the CLIs do not survive and servers are open', () => {
    expect(describeOpenSessions(summary({ clis: 1, rdp: 1 }))).toContain(
      'stops the CLI sessions and disconnects from every server',
    );
  });

  it('talks about disconnecting when only servers are open', () => {
    expect(describeOpenSessions(summary({ ssh: 1 }))).toContain('Closing the app disconnects it.');
    expect(describeOpenSessions(summary({ ssh: 1, rdp: 1 }))).toContain(
      'Closing the app disconnects them.',
    );
    // clisKeepRunning is irrelevant with no CLI open; it must not change the line.
    expect(describeOpenSessions(summary({ rdp: 2, clisKeepRunning: true }))).toContain(
      'Closing the app disconnects them.',
    );
  });

  it('always returns a two-line body', () => {
    // The dialog renders line one as the question and line two as the detail.
    for (const value of [
      summary({ clis: 1 }),
      summary({ ssh: 2, rdp: 1 }),
      summary({ clis: 1, ssh: 1, rdp: 1, clisKeepRunning: true }),
    ]) {
      expect(describeOpenSessions(value).split('\n')).toHaveLength(2);
    }
  });

  it('produces a nonsense line for an empty summary, so callers must guard first', () => {
    // There is no list to join, so the sentence comes out with a hole in it.
    // Both call sites check hasOpenSessions() before asking for this text; this
    // test is here so that stays a deliberate contract rather than a surprise.
    expect(describeOpenSessions(summary())).toContain('You still have  open.');
  });

  it('keeps the dialog labels stable', () => {
    // The e2e suite clicks the button by this label.
    expect(QUIT_CONFIRM_TITLE).toBe('Close Runova?');
    expect(QUIT_CONFIRM_LABEL).toBe('Close app');
  });
});
