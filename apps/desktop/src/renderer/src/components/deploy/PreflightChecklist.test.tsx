import type { DeployPreflight } from '@shared/deployTypes';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreflightChecklist, PreflightSkeleton } from './PreflightChecklist';

/**
 * The facts a check found, each marked ready, blocking or just worth knowing, and said out loud
 * for a screen reader since the marks are icons.
 */

const READY: DeployPreflight = {
  os: 'Ubuntu 24.04.1 LTS',
  supported: true,
  architecture: 'x86_64',
  architectureSupported: true,
  systemd: true,
  sudo: 'root',
  loginUser: 'root',
  hasSavedPassword: true,
  transport: 'streamlocal',
  selinux: 'absent',
  freeDiskMb: 20_480,
  serverDownload: false,
  installed: null,
  available: '1.53.0',
  problems: [],
};

function row(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: 'dt' });
  return term.parentElement as HTMLElement;
}

describe('PreflightChecklist', () => {
  it('lists a ready server without notes', () => {
    render(<PreflightChecklist preflight={READY} />);

    expect(row('Operating system').textContent).toContain('Ubuntu 24.04.1 LTS');
    expect(row('Operating system').textContent).toContain('ready');
    expect(row('Free space').textContent).toContain('20.0 GB under /opt and /var');
    expect(row('Root access').textContent).toContain('Signed in as root');
    expect(screen.queryByText('Connection', { selector: 'dt' })).toBeNull();
    expect(screen.queryByText('SELinux', { selector: 'dt' })).toBeNull();
  });

  it('marks what blocks an install', () => {
    render(
      <PreflightChecklist
        preflight={{
          ...READY,
          supported: false,
          os: '',
          architectureSupported: false,
          architecture: 'riscv64',
          systemd: false,
          sudo: null,
          freeDiskMb: 120,
        }}
      />,
    );

    for (const label of [
      'Operating system',
      'Processor',
      'Service manager',
      'Root access',
      'Free space',
    ]) {
      expect(row(label).textContent).toContain('blocks the install');
    }
    expect(row('Operating system').textContent).toContain('Unknown');
    expect(row('Root access').textContent).toContain('sudo is not installed');
  });

  it('says who fetches the core: the server when it reaches GitHub, the app otherwise', () => {
    const { rerender } = render(
      <PreflightChecklist preflight={{ ...READY, serverDownload: true }} />,
    );
    expect(row('Getting the core').textContent).toContain('The server downloads it from GitHub');
    expect(row('Getting the core').textContent).toContain('ready');

    rerender(<PreflightChecklist preflight={READY} />);
    expect(row('Getting the core').textContent).toContain('This app sends it over SSH');
    expect(row('Getting the core').textContent).toContain('note');
  });

  it('does not say how the core gets there while something else blocks the install', () => {
    render(<PreflightChecklist preflight={{ ...READY, problems: ['No systemd.'] }} />);

    expect(screen.queryByText('Getting the core', { selector: 'dt' })).toBeNull();
  });

  it('describes each way of getting root', () => {
    const { rerender } = render(
      <PreflightChecklist preflight={{ ...READY, sudo: 'passwordless' }} />,
    );
    expect(row('Root access').textContent).toContain('sudo, no password needed');

    rerender(
      <PreflightChecklist preflight={{ ...READY, sudo: 'password', hasSavedPassword: false }} />,
    );
    expect(row('Root access').textContent).toContain('sudo, asks for a password');

    rerender(<PreflightChecklist preflight={{ ...READY, sudo: 'password' }} />);
    expect(row('Root access').textContent).toContain('sudo, with the saved login password');
  });

  it('adds notes for the bridge, SELinux, an unknown disk and an existing core', () => {
    render(
      <PreflightChecklist
        preflight={{
          ...READY,
          transport: 'bridge',
          selinux: 'permissive',
          freeDiskMb: null,
          installed: { version: '1.52.0' },
        }}
      />,
    );

    expect(row('Connection').textContent).toContain("The core's own bridge");
    expect(row('SELinux').textContent).toContain('Permissive, so the files get labelled');
    expect(row('Free space').textContent).toContain('Could not tell');
    expect(row('Installed now').textContent).toContain('Server core 1.52.0');
    expect(row('Installed now').textContent).toContain('note');
  });
});

describe('PreflightSkeleton', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the server, then says it is slow when the check drags on', () => {
    vi.useFakeTimers();
    render(<PreflightSkeleton serverName="Staging" />);
    expect(screen.getByRole('status').textContent).toBe('Checking Staging.');

    act(() => {
      vi.advanceTimersByTime(8_000);
    });

    expect(screen.getByRole('status').textContent).toContain('Staging is slow to answer');
  });
});
