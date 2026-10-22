import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { notSetUp } from '../errorReporting/testing/fixtures';
import { CHECKLIST } from './checklist/testing/fixtures';
import { MARIA, SERVER, signedIn, THIS_COMPUTER, THIS_SESSION } from './testing/fixtures';

/**
 * A server's Security area shows only what the signed-in role may use: users for Owners, the
 * audit trail for Admins and Owners, and everyone's own devices and sessions. Without a session
 * it offers the way in instead of a dead end.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { SecurityPanel } = await import('./SecurityPanel');

function renderPanel(access: unknown) {
  return renderWithProviders(<SecurityPanel server={SERVER} />, {
    bridge: {
      'deploy.access': access,
      'deploySecurity.listUsers': async () => [MARIA],
      'deploySecurity.listDevices': async () => [THIS_COMPUTER],
      'deploySecurity.listSessions': async () => [THIS_SESSION],
      'deploySecurity.queryAudit': async () => ({ events: [] }),
      'deployHardening.checklist': async () => CHECKLIST,
      'deployErrorReporting.status': async () => notSetUp(),
    },
  });
}

describe('SecurityPanel', () => {
  it('shimmers while it finds out who is signed in', () => {
    const { container } = renderPanel(() => new Promise(() => undefined));

    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('offers the way in when this computer is not signed in', async () => {
    renderPanel(async () => ({ state: 'needs-sign-in' }));

    expect(await screen.findByText('Sign in to manage this core.')).toBeTruthy();
    expect(screen.getByText(/Sign in to see who can reach Production/)).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore a backup over SSH' })).toBeTruthy();
  });

  it('gives an Owner the checklist, users, devices and sessions, the audit trail and backups, starting with the checklist', async () => {
    const { user } = renderPanel(async () => signedIn(['owner']));

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Checklist',
      'Users',
      'Devices and sessions',
      'Audit trail',
      'Backups',
      'Error reporting',
      'Connection',
    ]);
    expect(await screen.findByRole('list', { name: 'Checklist' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Users' }));
    expect(await screen.findByRole('listitem', { name: 'maria' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Backups' }));
    expect(await screen.findByRole('button', { name: 'Back up now' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Audit trail' }));

    expect(await screen.findByText('Nothing has been recorded yet.')).toBeTruthy();
  });

  it('gives an Admin the checklist, devices of everyone and the audit trail, but no users or backups', async () => {
    const { user } = renderPanel(async () => signedIn(['admin']));

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Checklist',
      'Devices and sessions',
      'Audit trail',
      'Error reporting',
      'Connection',
    ]);
    await user.click(screen.getByRole('tab', { name: 'Devices and sessions' }));
    expect(await screen.findByText(/Every computer enrolled on this core/)).toBeTruthy();
    const devices = await screen.findByRole('list', { name: 'Devices' });
    expect(within(devices).getByRole('listitem', { name: 'Maria-PC' })).toBeTruthy();
  });

  it('opens error reporting from its tab, with the form for an Owner and none for an Admin', async () => {
    const owner = renderPanel(async () => signedIn(['owner']));
    await owner.user.click(await screen.findByRole('tab', { name: 'Error reporting' }));
    expect(await screen.findByLabelText('Sentry DSN')).toBeTruthy();
    owner.unmount();

    const admin = renderPanel(async () => signedIn(['admin']));
    await admin.user.click(await screen.findByRole('tab', { name: 'Error reporting' }));
    expect(await screen.findByText(/An Owner can set this up/)).toBeTruthy();
    expect(screen.queryByLabelText('Sentry DSN')).toBeNull();
  });

  it('moves an Owner who stepped down off the Users tab', async () => {
    const { queryClient, user } = renderPanel(async () => signedIn(['owner']));
    expect(await screen.findByRole('tab', { name: 'Users' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Users' }));

    act(() => {
      queryClient.setQueryData(queryKeys.deployAccess('srv-1'), signedIn(['admin']));
    });

    expect(await screen.findByRole('list', { name: 'Checklist' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Users' })).toBeNull();
  });

  it('gives a Viewer their own devices and sessions only', async () => {
    renderPanel(async () => signedIn(['viewer']));

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Devices and sessions', 'Connection']);
    expect(await screen.findByText(/Your computers enrolled on this core/)).toBeTruthy();
    expect(screen.getByText('Your sessions')).toBeTruthy();
  });
});
