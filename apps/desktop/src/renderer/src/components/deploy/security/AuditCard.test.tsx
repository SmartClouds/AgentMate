import type { AuditPage } from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { auditEvent, DAY, SERVER } from './testing/fixtures';

/**
 * The audit trail of a core, for Admins and Owners: every sign-in, change and refusal, newest
 * first, filtered by who, what, result and time, a page at a time. It can be saved as JSON or CSV,
 * and its hash chain checked, with the answer said plainly either way.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { AuditCard } = await import('./AuditCard');

const PAGE: AuditPage = {
  events: [
    auditEvent(1, { action: 'user.create', target: 'sam', parameters: '{"role":"operator"}' }),
    auditEvent(2, { action: 'user.delete', target: 'kim', result: 'denied' }),
    auditEvent(3, {
      action: 'auth.login',
      target: 'ghost',
      result: 'failed',
      actorUserId: undefined,
      actorUserName: undefined,
      deviceId: undefined,
      deviceName: undefined,
    }),
    auditEvent(4, {
      action: 'admin.revoke-all',
      target: undefined,
      actorUserId: undefined,
      actorUserName: undefined,
      deviceId: undefined,
      deviceName: undefined,
      peerUid: 1000,
      parameters: '{"via":"admin-cli","sudoUser":"deployer"}',
    }),
    auditEvent(5, { action: 'job.cancel', result: 'cancelled', actorUserName: undefined }),
  ],
};

function renderCard(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<AuditCard server={SERVER} />, {
    bridge: {
      'deploySecurity.queryAudit': async () => PAGE,
      ...bridge,
    },
  });
}

const row = (action: string) =>
  screen.getAllByRole('row').find((candidate) => candidate.textContent?.includes(action));

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('AuditCard', () => {
  it('shimmers while the trail loads', () => {
    const { container } = renderCard({
      'deploySecurity.queryAudit': () => new Promise(() => undefined),
    });

    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('says why it could not be read, and asks again on request', async () => {
    let calls = 0;
    const { user } = renderCard({
      'deploySecurity.queryAudit': async () => {
        calls += 1;
        if (calls === 1) throw new Error('The core did not answer in time.');
        return PAGE;
      },
    });

    expect(await screen.findByText('The core did not answer in time.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Try again/ }));

    expect(await screen.findByText('user.create')).toBeTruthy();
  });

  it('says so when nothing was recorded yet', async () => {
    renderCard({ 'deploySecurity.queryAudit': async () => ({ events: [] }) });

    expect(await screen.findByText('Nothing has been recorded yet.')).toBeTruthy();
  });

  it('lists who did what to what, and how it ended, in words', async () => {
    renderCard();

    await screen.findByText('user.create');
    const created = within(row('user.create') as HTMLElement);
    expect(created.getByText('maria')).toBeTruthy();
    expect(created.getByText('Maria-PC')).toBeTruthy();
    expect(created.getByText('sam')).toBeTruthy();
    expect(created.getByText('{"role":"operator"}')).toBeTruthy();
    expect(created.getByText('Succeeded')).toBeTruthy();
    expect(within(row('user.delete') as HTMLElement).getByText('Refused')).toBeTruthy();
    const failed = within(row('auth.login') as HTMLElement);
    expect(failed.getByText('Failed')).toBeTruthy();
    expect(failed.getByText('Nobody signed in')).toBeTruthy();
    expect(
      within(row('admin.revoke-all') as HTMLElement).getByText('Command over SSH (deployer)'),
    ).toBeTruthy();
    const cancelled = within(row('job.cancel') as HTMLElement);
    expect(cancelled.getByText('Cancelled')).toBeTruthy();
    expect(cancelled.getByText('A removed user')).toBeTruthy();
  });

  it('asks the core again with each filter, and says when nothing matches', async () => {
    const queryAudit = vi.fn(async (_query: unknown): Promise<AuditPage> => PAGE);
    const { user } = renderCard({ 'deploySecurity.queryAudit': queryAudit });
    await screen.findByText('user.create');

    await user.click(screen.getByRole('combobox', { name: 'Action' }));
    await user.click(await screen.findByRole('option', { name: 'Users' }));
    await user.click(screen.getByRole('combobox', { name: 'Result' }));
    await user.click(await screen.findByRole('option', { name: 'Failed' }));
    queryAudit.mockResolvedValue({ events: [] });
    await user.type(screen.getByLabelText('Who'), 'sam{Enter}');
    await user.click(screen.getByRole('combobox', { name: 'When' }));
    await user.click(await screen.findByRole('option', { name: 'Last 24 hours' }));

    expect(await screen.findByText('Nothing matches these filters.')).toBeTruthy();
    const last = queryAudit.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(last).toMatchObject({
      serverId: 'srv-1',
      action: 'user.',
      result: 'failed',
      actor: 'sam',
      limit: 50,
    });
    expect(Number(last.fromUnixMs)).toBeGreaterThan(Date.now() - DAY - 60_000);
    expect(Number(last.fromUnixMs)).toBeLessThanOrEqual(Date.now() - DAY + 1_000);
  });

  it('reads older pages on request until there are none', async () => {
    const queryAudit = vi
      .fn()
      .mockResolvedValueOnce({ events: [auditEvent(40)], nextBeforeId: 40 })
      .mockResolvedValueOnce({
        events: [auditEvent(39, { action: 'device.revoke', target: 'old-desktop' })],
      });
    const { user } = renderCard({ 'deploySecurity.queryAudit': queryAudit });

    await user.click(await screen.findByRole('button', { name: /Load older events/ }));

    expect(await screen.findByText('device.revoke')).toBeTruthy();
    expect(queryAudit).toHaveBeenLastCalledWith(expect.objectContaining({ beforeId: 40 }));
    expect(screen.queryByRole('button', { name: /Load older events/ })).toBeNull();
  });

  it('checks the chain and says plainly that it holds', async () => {
    const { user } = renderCard({
      'deploySecurity.verifyAudit': async () => ({ intact: true, checked: 1234 }),
    });

    await user.click(await screen.findByRole('button', { name: /Check the chain/ }));

    expect((await screen.findByRole('status')).textContent).toMatch(
      /The trail is intact: all 1,234 events check out\./,
    );
  });

  it('says plainly where the chain breaks', async () => {
    const { user } = renderCard({
      'deploySecurity.verifyAudit': async () => ({ intact: false, checked: 122, brokenAt: 123 }),
    });

    await user.click(await screen.findByRole('button', { name: /Check the chain/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/broken at event 123/);
    expect(alert.textContent).toMatch(/changed or removed after it was written/);
    expect(alert.textContent).toMatch(/The 122 events before it check out/);
  });

  it('says why the chain could not be checked', async () => {
    const { user } = renderCard({
      'deploySecurity.verifyAudit': async () => {
        throw new Error('The core did not answer in time.');
      },
    });

    await user.click(await screen.findByRole('button', { name: /Check the chain/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('The core did not answer in time.'),
    );
  });

  it('exports what the filters show, as CSV or JSON, to the file the user picks', async () => {
    const exportAudit = vi
      .fn()
      .mockResolvedValueOnce({ saved: true, path: 'C:\\audit.csv', count: 5, truncated: false })
      .mockResolvedValueOnce({ saved: false })
      .mockResolvedValueOnce({ saved: true, path: '/tmp/a.json', count: 50000, truncated: true });
    const { user } = renderCard({ 'deploySecurity.exportAudit': exportAudit });
    await screen.findByText('user.create');
    await user.click(screen.getByRole('combobox', { name: 'Result' }));
    await user.click(await screen.findByRole('option', { name: 'Refused' }));

    await user.click(screen.getByRole('button', { name: /Export/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'As CSV' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Saved 5 events to C:\\audit.csv.', {}),
    );
    expect(exportAudit).toHaveBeenCalledWith({
      serverId: 'srv-1',
      format: 'csv',
      filter: { result: 'denied' },
    });

    await user.click(screen.getByRole('button', { name: /Export/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'As JSON' }));
    await waitFor(() => expect(exportAudit).toHaveBeenCalledTimes(2));
    expect(toast.success).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /Export/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'As JSON' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenLastCalledWith('Saved 50,000 events to /tmp/a.json.', {
        description:
          'More matched than one export holds, so the file has the newest. Narrow the filters to reach older ones.',
      }),
    );
  });

  it('passes on why an export failed', async () => {
    const { user } = renderCard({
      'deploySecurity.exportAudit': async () => {
        throw new Error("Error invoking remote method 'deploySecurity:exportAudit': Error: EACCES");
      },
    });
    await screen.findByText('user.create');

    await user.click(screen.getByRole('button', { name: /Export/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'As CSV' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('EACCES'));
  });
});
