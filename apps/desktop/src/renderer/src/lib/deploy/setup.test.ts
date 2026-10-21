import type { DeployPreflight, DeploySetupProgress } from '@shared/deployTypes';
import { describe, expect, it } from 'vitest';
import { formatUptime, installPhases, SETUP_LABELS, timeline } from './setup';

/**
 * What the install wizard shows: the whole plan up front, each step's latest state as progress
 * arrives, and steps that only happen on the way (going back to the previous release) where
 * they happened.
 */

const PREFLIGHT = { selinux: 'absent' } as DeployPreflight;

const event = (
  phase: DeploySetupProgress['phase'],
  status: DeploySetupProgress['status'],
  extra: Partial<DeploySetupProgress> = {},
): DeploySetupProgress => ({ phase, title: phase, status, ...extra });

describe('installPhases', () => {
  it('lists the install steps in order', () => {
    expect(installPhases(PREFLIGHT)).toEqual([
      'preflight',
      'download',
      'upload',
      'verify',
      'group',
      'extract',
      'unit',
      'switch',
      'start',
      'cleanup',
      'health',
    ]);
  });

  it('has a server that reaches GitHub download the core itself, with no upload', () => {
    const phases = installPhases({ ...PREFLIGHT, serverDownload: true });

    expect(phases.slice(0, 3)).toEqual(['preflight', 'fetch', 'verify']);
    expect(phases).not.toContain('download');
    expect(phases).not.toContain('upload');
  });

  it('has the app get the core and upload it when the server cannot reach GitHub', () => {
    const phases = installPhases({ ...PREFLIGHT, serverDownload: false });

    expect(phases.slice(0, 4)).toEqual(['preflight', 'download', 'upload', 'verify']);
    expect(phases).not.toContain('fetch');
  });

  it('adds SELinux labels where SELinux is on', () => {
    expect(installPhases({ ...PREFLIGHT, selinux: 'enforcing' })).toContain('selinux');
    expect(installPhases({ ...PREFLIGHT, selinux: 'permissive' })).toContain('selinux');
    expect(installPhases({ ...PREFLIGHT, selinux: 'disabled' })).not.toContain('selinux');
  });
});

describe('timeline', () => {
  it('starts with every step pending', () => {
    const steps = timeline(['preflight', 'download'], []);

    expect(steps).toEqual([
      { phase: 'preflight', label: SETUP_LABELS.preflight, status: 'pending' },
      { phase: 'download', label: SETUP_LABELS.download, status: 'pending' },
    ]);
  });

  it('keeps the latest state of each step', () => {
    const steps = timeline(
      ['preflight', 'upload'],
      [
        event('preflight', 'running'),
        event('preflight', 'done'),
        event('upload', 'running'),
        event('upload', 'running', { percent: 40 }),
      ],
    );

    expect(steps.map((step) => step.status)).toEqual(['done', 'running']);
    expect(steps[1].percent).toBe(40);
  });

  it('keeps the upload percentage when a later event carries none', () => {
    const steps = timeline(
      ['upload'],
      [event('upload', 'running', { percent: 70 }), event('upload', 'done')],
    );

    expect(steps[0]).toMatchObject({ status: 'done', percent: 70 });
  });

  it('shows why a step failed', () => {
    const steps = timeline(['extract'], [event('extract', 'failed', { detail: 'tar: disk full' })]);

    expect(steps[0]).toMatchObject({ status: 'failed', detail: 'tar: disk full' });
  });

  it('puts an unplanned step right after the one it followed', () => {
    const steps = timeline(
      ['switch', 'start', 'cleanup', 'health'],
      [
        event('switch', 'done'),
        event('start', 'failed'),
        event('rollback', 'running'),
        event('rollback', 'done'),
      ],
    );

    expect(steps.map((step) => step.phase)).toEqual([
      'switch',
      'start',
      'rollback',
      'cleanup',
      'health',
    ]);
    expect(steps[2]).toMatchObject({ status: 'done', label: SETUP_LABELS.rollback });
  });

  it("adds the app's download and upload where they happen when the server could not fetch it", () => {
    const steps = timeline(
      ['preflight', 'fetch', 'verify'],
      [
        event('preflight', 'done'),
        event('fetch', 'running'),
        event('fetch', 'done', { detail: 'The server could not download it (...), so ...' }),
        event('download', 'running'),
        event('download', 'done'),
        event('upload', 'running', { percent: 50 }),
        event('upload', 'done'),
        event('verify', 'running'),
      ],
    );

    expect(steps.map((step) => step.phase)).toEqual([
      'preflight',
      'fetch',
      'download',
      'upload',
      'verify',
    ]);
    expect(steps[1]).toMatchObject({ status: 'done', detail: expect.stringMatching(/could not/) });
    expect(steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done', 'running']);
  });
});

describe('formatUptime', () => {
  const now = 1_000_000_000_000;

  it('reads like a person would say it', () => {
    expect(formatUptime(now - 20_000, now)).toBe('less than a minute');
    expect(formatUptime(now - 5 * 60_000, now)).toBe('5 min');
    expect(formatUptime(now - (2 * 60 + 5) * 60_000, now)).toBe('2 h 5 min');
    expect(formatUptime(now - 3 * 3_600_000, now)).toBe('3 h');
    expect(formatUptime(now - (4 * 24 + 3) * 3_600_000, now)).toBe('4 days 3 h');
    expect(formatUptime(now - 24 * 3_600_000, now)).toBe('1 day');
  });

  it('never shows a negative time when the clocks disagree', () => {
    expect(formatUptime(now + 60_000, now)).toBe('less than a minute');
  });
});
