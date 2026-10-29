import { encodeCoreError } from '@shared/coreErrors';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SERVER, signedIn } from '../security/testing/fixtures';
import {
  BLOCKED,
  CHANGE_ID,
  changeSet,
  EXPOSURE,
  PRESETS,
  preview,
  status,
} from './testing/fixtures';

/**
 * The Firewall section through its states: shimmer, read only for a Viewer, staging a rule,
 * reviewing the exact commands, applying, the countdown, keeping or reverting, a keep that fails
 * (the countdown goes on), the SSH guard's typed override, a step-up, and turning it off.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { FirewallPanel } = await import('./FirewallPanel');

beforeEach(() => {
  toast.success.mockClear();
  toast.warning.mockClear();
  confirm.mockClear();
});

function renderPanel(overrides: Record<string, unknown> = {}, roles = ['admin']) {
  return renderWithProviders(<FirewallPanel server={SERVER} />, {
    bridge: {
      'deploy.access': async () => signedIn(roles),
      'deploy.connection': async () => ({ serverId: SERVER.id, state: 'online', since: 0 }),
      'deployFirewall.status': async () => status(),
      'deployFirewall.presets': async () => PRESETS,
      'deployFirewall.history': async () => [],
      'deployFirewall.exposure': async () => EXPOSURE,
      'deployFirewall.preview': async () => preview(),
      'deployFirewall.applyChanges': async () => changeSet(),
      ...overrides,
    },
  });
}

/** Stages port 8080 through the rule form and opens the review. */
async function stageAndReview(user: ReturnType<typeof renderPanel>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Add rule' }));
  await user.type(screen.getByLabelText('Ports'), '8080');
  await user.click(screen.getByRole('button', { name: 'Stage the rule' }));
  const staged = screen.getByRole('region', { name: 'Staged changes' });
  expect(within(staged).getByText('Add: Allow port 8080 TCP')).toBeTruthy();
  await user.click(within(staged).getByRole('button', { name: 'Review and apply' }));
  return screen.findByRole('dialog', { name: 'Review the firewall change' });
}

describe('FirewallPanel', () => {
  it('shimmers per card while the firewall is read', async () => {
    const { container } = renderPanel({
      'deployFirewall.status': () => new Promise(() => undefined),
    });

    await screen.findByText('Rules');
    expect(container.querySelectorAll('[aria-busy="true"] .shimmer').length).toBeGreaterThan(1);
  });

  it('offers the way in when this computer is not signed in', async () => {
    renderPanel({ 'deploy.access': async () => ({ state: 'needs-sign-in' }) });

    expect(await screen.findByText(/Sign in to see the firewall on Production/)).toBeTruthy();
  });

  it('shows a Viewer everything and no way to change it', async () => {
    renderPanel({}, ['viewer']);

    expect(await screen.findByText('Firewall on')).toBeTruthy();
    expect(screen.getByText('Incoming default').nextElementSibling?.textContent).toBe('Deny');
    expect(await screen.findByRole('row', { name: 'Rule 22 Anywhere' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
    expect(screen.getByText('Read only')).toBeTruthy();
    expect(await screen.findByText('shop-db-1')).toBeTruthy();
    const db = screen.getByRole('listitem', { name: 'shop-db-1' });
    expect(within(db).getByRole('button', { name: 'Make private' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('stages a rule, previews the exact commands, applies it and keeps it', async () => {
    const { user, bridge } = renderPanel({
      'deployFirewall.confirm': async () => changeSet({ state: 'confirmed' }),
    });

    const review = await stageAndReview(user);
    bridge.$set('deployFirewall.status', async () => status({ pending: changeSet() }));
    expect(await within(review).findByLabelText('Commands')).toHaveProperty(
      'textContent',
      'ufw allow 8080/tcp',
    );
    expect(bridge.$fn('deployFirewall.preview')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      changes: [{ kind: 'addRule', rule: { action: 'allow', protocol: 'tcp', port: 8080 } }],
    });
    await user.click(within(review).getByRole('button', { name: 'Apply' }));

    const timer = await screen.findByRole('timer');
    expect(timer.getAttribute('aria-label')).toMatch(/^(60|59) seconds left$/);
    expect(screen.getByRole('heading', { name: 'Keep changes?' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Staged changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull();

    bridge.$set('deployFirewall.status', async () => status());
    await user.click(screen.getByRole('button', { name: 'Keep changes' }));
    expect(bridge.$fn('deployFirewall.confirm')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      changeSetId: CHANGE_ID,
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Firewall change kept.'));
    await waitFor(() => expect(screen.queryByRole('timer')).toBeNull());
  });

  it('keeps counting down when keeping fails, and shows each step', async () => {
    const { user, bridge } = renderPanel({
      'deployFirewall.status': async () => status({ pending: changeSet() }),
      'deployFirewall.confirm': async () => {
        throw new Error('A new SSH connection could not get in (timed out).');
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Keep changes' }));
    act(() =>
      bridge.$emit('deployFirewall.onProgress', {
        serverId: SERVER.id,
        operation: 'confirm',
        step: 'openingConnection',
        state: 'failed',
        message: 'timed out',
        atUnixMs: Date.now(),
      }),
    );

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not get in/);
    expect(
      screen.getByRole('listitem', { name: 'Opening a new SSH connection: failed' }),
    ).toBeTruthy();
    expect(screen.getByRole('timer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep changes' })).toHaveProperty('disabled', false);
  });

  it('reverts a waiting change', async () => {
    const { user, bridge } = renderPanel({
      'deployFirewall.status': async () => status({ pending: changeSet() }),
      'deployFirewall.revert': async () => changeSet({ state: 'rolledBack', rolledBackBy: 'user' }),
    });

    await user.click(await screen.findByRole('button', { name: 'Revert' }));

    expect(bridge.$fn('deployFirewall.revert')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      changeSetId: CHANGE_ID,
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Firewall change reverted. The old rules are back.',
      ),
    );
  });

  it('says so when the timer rolled a change back', async () => {
    const { bridge, queryClient } = renderPanel({
      'deployFirewall.status': async () =>
        status({ pending: changeSet({ deadlineUnixMs: Date.now() - 1 }) }),
    });

    expect(await screen.findByText('Time is up: the old rules are coming back')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep changes' })).toHaveProperty('disabled', true);
    bridge.$set('deployFirewall.status', async () => status());
    bridge.$set('deployFirewall.history', async () => [
      changeSet({ state: 'rolledBack', rolledBackBy: 'timer' }),
    ]);
    await act(() => queryClient.invalidateQueries());

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(await screen.findByText(/Rolled back: nobody kept it in time/)).toBeTruthy();
  });

  it('asks for the guard phrase before applying a change that closes SSH', async () => {
    const { user, bridge } = renderPanel({ 'deployFirewall.preview': async () => BLOCKED });

    await user.click(await screen.findByRole('button', { name: 'Remove the rule for 22' }));
    expect(screen.getByText('Will be removed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Review and apply' }));
    const review = await screen.findByRole('dialog');
    expect(await within(review).findByText(/could lock this computer out/)).toBeTruthy();
    const apply = within(review).getByRole('button', { name: 'Apply anyway' });
    expect(apply).toHaveProperty('disabled', true);

    await user.type(within(review).getByLabelText(/To apply it anyway/), 'block ssh on port 22');
    expect(apply).toHaveProperty('disabled', false);
    await user.click(apply);

    expect(bridge.$fn('deployFirewall.applyChanges')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      changes: [{ kind: 'removeRule', ruleId: 'r1' }],
      overrideConfirmation: 'block ssh on port 22',
    });
  });

  it('turns the firewall off after the typed name and a step-up', async () => {
    let calls = 0;
    const off = changeSet({ summary: 'turn the firewall off' });
    const { user, bridge } = renderPanel({
      'deployFirewall.status': async () => status(calls > 1 ? { pending: off } : {}),
      'deployFirewall.preview': async () => preview({ needsStepUp: true }),
      'deployFirewall.applyChanges': async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error(encodeCoreError('stepUpRequired', 'Needs your password again.'));
        }
        return off;
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ typeToConfirm: 'Production', variant: 'destructive' }),
    );
    const review = await screen.findByRole('dialog');
    expect(await within(review).findByText(/asks for your password again/)).toBeTruthy();
    await user.click(within(review).getByRole('button', { name: 'Apply' }));
    await user.type(await screen.findByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await screen.findByRole('timer');
    expect(bridge.$fn('deployFirewall.applyChanges')).toHaveBeenLastCalledWith({
      serverId: SERVER.id,
      changes: [{ kind: 'disable' }],
      password: 'secret',
    });
  });

  it('stages an edit as a removal and an addition, and takes both back together', async () => {
    const { user } = renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Edit the rule for 443' }));
    const ports = screen.getByLabelText('Ports');
    await user.clear(ports);
    await user.type(ports, '8443');
    await user.click(screen.getByRole('button', { name: 'Stage the edit' }));

    expect(screen.getByText('2 changes staged, not applied yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByRole('region', { name: 'Staged changes' })).toBeNull();
  });

  it('stages a preset, and opens the form for one best kept to a network', async () => {
    const { user } = renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Stage the HTTP preset' }));
    expect(screen.getByText('Add: Allow port 80 TCP')).toBeTruthy();
    expect(within(screen.getByRole('listitem', { name: 'SSH' })).getByText('Open')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Stage the PostgreSQL preset' }));
    expect(screen.getByText(/best kept to your own network, such as 10\.0\.0\.0\/8/)).toBeTruthy();
    await user.type(screen.getByLabelText('Source'), '10.0.0.0/8');
    await user.click(screen.getByRole('button', { name: 'Stage the rule' }));
    expect(screen.getByText('Add: Allow port 5432 TCP from 10.0.0.0/8')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Staged changes' })).toBeNull();
  });
});
