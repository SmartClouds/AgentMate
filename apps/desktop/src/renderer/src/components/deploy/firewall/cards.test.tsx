import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { CountdownBanner } from './CountdownBanner';
import { ExposureCard } from './ExposureCard';
import { HistoryCard } from './HistoryCard';
import { RuleDialog } from './RuleDialog';
import { StatusHero } from './StatusHero';
import { changeSet, EXPOSURE, status } from './testing/fixtures';

/** The Firewall cards on their own, through the states the panel tests do not reach. */

const hero = (props: Partial<Parameters<typeof StatusHero>[0]> = {}) =>
  renderWithProviders(
    <StatusHero
      status={status()}
      loading={false}
      error={null}
      stale={false}
      canAdmin
      busy={false}
      onToggle={vi.fn()}
      onDefaultIncoming={vi.fn()}
      {...props}
    />,
  );

describe('StatusHero', () => {
  it('says the firewall is off in words, and offers to turn it on', async () => {
    const onToggle = vi.fn();
    const { user } = hero({
      status: status({ active: false, zone: 'public', warnings: ['IPv6 is off in ufw.'] }),
      onToggle,
    });

    expect(screen.getByText('Firewall off')).toBeTruthy();
    expect(screen.getByText('ufw (zone public)')).toBeTruthy();
    expect(screen.getByText('IPv6 is off in ufw.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('wraps its settings instead of cutting them off in a narrow window', () => {
    const view = hero();

    const settings = view.container.querySelector('dl') as HTMLElement;
    expect(settings.className).toContain('auto-fill');
    for (const value of settings.querySelectorAll('dd')) {
      expect(value.className).not.toContain('truncate');
    }
    // The dropdown is the value itself, so nothing clips it either.
    expect(screen.getByLabelText('Incoming by default').closest('dd')).toBeTruthy();
  });

  it('stages a new incoming default', async () => {
    const onDefaultIncoming = vi.fn();
    const { user } = hero({ onDefaultIncoming });

    await user.click(screen.getByRole('combobox', { name: 'Incoming by default' }));
    await user.click(await screen.findByRole('option', { name: 'Reject' }));
    expect(onDefaultIncoming).toHaveBeenCalledWith('reject');
  });

  it('marks an incoming default that is staged but not applied', () => {
    const view = hero({ stagedIncoming: 'reject' });

    expect(screen.getByRole('combobox', { name: 'Incoming by default' }).textContent).toBe(
      'Reject',
    );
    expect(screen.getByText('Not applied yet')).toBeTruthy();
    view.unmount();

    hero();
    expect(screen.queryByText('Not applied yet')).toBeNull();
  });

  it('says when no firewall is installed, when SSH ports are unknown, and when it failed', () => {
    const view = hero({
      status: status({
        backend: 'none',
        installed: false,
        ssh: { ports: [], error: 'sshd -T failed' },
        ipv6: false,
        error: 'ufw is missing.',
      }),
    });
    expect(screen.getByText('No firewall found')).toBeTruthy();
    expect(screen.getByText('sshd -T failed')).toBeTruthy();
    expect(screen.getByText('Not filtered')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Turn/ })).toBeNull();
    view.unmount();

    hero({ status: undefined, error: 'The connection dropped.' });
    expect(screen.getByRole('alert').textContent).toBe('The connection dropped.');
  });
});

describe('CountdownBanner', () => {
  const banner = (props: Partial<Parameters<typeof CountdownBanner>[0]> = {}) =>
    renderWithProviders(
      <CountdownBanner
        change={changeSet({ deadlineUnixMs: 100_000 })}
        windowSeconds={60}
        now={60_000}
        busy={null}
        steps={[]}
        problem={null}
        canDecide
        onKeep={vi.fn()}
        onRevert={vi.fn()}
        {...props}
      />,
    );

  it('burns the fuse down with the time left and turns urgent in the last 10 seconds', () => {
    const view = banner();
    expect(screen.getByRole('timer').textContent).toBe('0:40');
    expect(screen.getByTestId('fuse').style.transform).toBe('scaleX(0.6666666666666666)');
    view.unmount();

    banner({ now: 90_000 });
    expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('10 seconds left');
    expect(screen.getByText('10 seconds left to keep the change.')).toBeTruthy();
  });

  it('waits for a deadline while the change is still applying, and shows others who decides', () => {
    banner({ change: changeSet({ deadlineUnixMs: undefined }), canDecide: false });

    expect(screen.getByRole('heading', { name: 'Applying the firewall change' })).toBeTruthy();
    expect(screen.getByText('Waiting for maria to keep it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep changes' })).toBeNull();
  });

  it('shows a revert in progress', () => {
    banner({ busy: 'revert', steps: [{ step: 'reverting', state: 'running' }] });

    expect(screen.getByRole('button', { name: 'Revert' })).toHaveProperty('disabled', true);
    expect(
      screen.getByRole('listitem', { name: 'Putting the old rules back: in progress' }),
    ).toBeTruthy();
  });
});

describe('HistoryCard', () => {
  it('lists each change with how it ended and its commands', () => {
    renderWithProviders(
      <HistoryCard
        changes={[
          changeSet({ id: 'a', state: 'confirmed', summary: 'open 8080' }),
          changeSet({
            id: 'b',
            state: 'rolledBack',
            rolledBackBy: 'timer',
            summary: 'close 22',
            guardOverridden: true,
          }),
          changeSet({
            id: 'c',
            state: 'failed',
            summary: 'odd one',
            error: 'ufw said no',
            requestedBy: undefined,
            appliedFrom: undefined,
          }),
          changeSet({ id: 'd', summary: 'still waiting' }),
        ]}
        loading={false}
        error={null}
        now={Date.now()}
      />,
    );

    const timer = screen.getByRole('listitem', { name: 'close 22' });
    expect(within(timer).getByText(/Rolled back: nobody kept it in time/)).toBeTruthy();
    expect(within(timer).getByText('SSH check overridden')).toBeTruthy();
    expect(
      within(screen.getByRole('listitem', { name: 'odd one' })).getByText(/ufw said no/),
    ).toBeTruthy();
    expect(screen.getAllByText('ufw allow 8080/tcp')).toHaveLength(4);
  });

  it('says when there is nothing yet, or it could not be read', () => {
    const view = renderWithProviders(
      <HistoryCard changes={[]} loading={false} error={null} now={0} />,
    );
    expect(screen.getByText(/No changes yet/)).toBeTruthy();
    view.unmount();
    renderWithProviders(
      <HistoryCard changes={undefined} loading={false} error="Refused." now={0} />,
    );
    expect(screen.getByRole('alert').textContent).toBe('Refused.');
  });
});

describe('ExposureCard', () => {
  it('marks what goes around the firewall, with make private off without the role', () => {
    renderWithProviders(<ExposureCard exposure={EXPOSURE} loading={false} error={null} />);

    const db = screen.getByRole('listitem', { name: 'shop-db-1' });
    expect(within(db).getByText('Bypasses the firewall')).toBeTruthy();
    expect(within(db).getByRole('button', { name: 'Make private' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('This machine only')).toBeTruthy();
  });

  it('says when Docker is not there, nothing is published, or the sockets could not be read', () => {
    const view = renderWithProviders(
      <ExposureCard
        exposure={{
          ...EXPOSURE,
          sockets: [{ ...EXPOSURE.sockets[0], address: '::', process: undefined, firewall: 'off' }],
          dockerAvailable: false,
        }}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('Docker is not running on this server.')).toBeTruthy();
    expect(screen.getByText('[::]:22/tcp')).toBeTruthy();
    expect(screen.getByText('Firewall off')).toBeTruthy();
    view.unmount();

    const second = renderWithProviders(
      <ExposureCard
        exposure={{ ...EXPOSURE, containers: [], socketsError: 'ss failed' }}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('No container publishes a port.')).toBeTruthy();
    expect(screen.getByText('ss failed')).toBeTruthy();
    second.unmount();

    renderWithProviders(<ExposureCard exposure={undefined} loading={false} error={null} />);
    expect(screen.getByRole('alert').textContent).toMatch(/could not be read/);
  });
});

describe('RuleDialog', () => {
  it('says what is wrong only after a try, and stages the rule once it is right', async () => {
    const onSave = vi.fn();
    const { user } = renderWithProviders(
      <RuleDialog
        open
        initial={{ action: 'allow', protocol: 'tcp', ports: '', source: '', comment: '' }}
        editing={false}
        onOpenChange={vi.fn()}
        onSave={onSave}
      />,
    );

    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Stage the rule' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Give a port or a source/);

    await user.click(screen.getByRole('combobox', { name: 'Action' }));
    await user.click(await screen.findByRole('option', { name: 'Limit' }));
    expect(screen.getByText(/connects 6 times in 30 seconds/)).toBeTruthy();
    await user.click(screen.getByRole('combobox', { name: 'Protocol' }));
    await user.click(await screen.findByRole('option', { name: 'UDP' }));
    await user.type(screen.getByLabelText('Ports'), '51820');
    await user.type(screen.getByLabelText('Comment'), 'wireguard');
    await user.click(screen.getByRole('button', { name: 'Stage the rule' }));
    expect(onSave).toHaveBeenCalledWith({
      action: 'limit',
      protocol: 'udp',
      port: 51820,
      comment: 'wireguard',
    });
  });
});
