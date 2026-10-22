import { describe, expect, it } from 'vitest';
import { destinationOf, levelLabel, reportingState } from './messages';
import { notSetUp, reporting } from './testing/fixtures';

describe('reportingState', () => {
  it('says not set up when nothing is stored', () => {
    expect(reportingState(notSetUp())).toMatchObject({ key: 'off', label: 'Not set up' });
  });

  it('says paused when it is stored but switched off', () => {
    expect(reportingState(reporting({ enabled: false }))).toMatchObject({
      key: 'paused',
      label: 'Paused',
    });
  });

  it('says it is waiting when it is on and has sent nothing yet', () => {
    expect(reportingState(reporting())).toMatchObject({
      key: 'waiting',
      label: 'On, nothing sent yet',
      tone: 'primary',
    });
  });

  it('says sending once something was delivered', () => {
    expect(reportingState(reporting({ sentCount: 3, lastSentAtUnixMs: 1_000 }))).toMatchObject({
      key: 'sending',
      label: 'Sending',
      tone: 'success',
    });
  });

  it('says the last send failed while the core still holds an error', () => {
    expect(
      reportingState(
        reporting({ lastError: 'Sentry rejected the key.', lastFailedAtUnixMs: 2_000 }),
      ),
    ).toMatchObject({ key: 'failing', label: 'Last send failed', tone: 'destructive' });
  });

  it('prefers the failure over an earlier delivery', () => {
    expect(
      reportingState(
        reporting({
          sentCount: 5,
          lastSentAtUnixMs: 1_000,
          lastError: 'Could not reach the host.',
          lastFailedAtUnixMs: 2_000,
        }),
      ).key,
    ).toBe('failing');
  });
});

describe('destinationOf', () => {
  it('names the host and the project, never a key', () => {
    expect(destinationOf(reporting())).toBe('o1.ingest.sentry.io, project 42');
    expect(destinationOf(notSetUp())).toBeNull();
  });
});

describe('levelLabel', () => {
  it('uses the words of the form', () => {
    expect(levelLabel('warning')).toBe('Warnings and errors');
    expect(levelLabel('error')).toBe('Errors only');
    expect(levelLabel('something else')).toBe('Warnings and errors');
  });
});
