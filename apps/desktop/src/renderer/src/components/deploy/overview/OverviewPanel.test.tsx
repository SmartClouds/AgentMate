import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import {
  connection,
  metricsSample,
  overviewBridge,
  SERVER,
  STEP_UP_REFUSAL,
  sampleAlert,
  sampleJob,
  sampleUpdates,
} from './testing/fixtures';

/**
 * The Overview end to end in the renderer: what a signed-in user sees of a server, what each
 * role may change, and how the page behaves while the connection is down and after a reboot.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { OverviewPanel } = await import('./OverviewPanel');
const { useConnectionUpdates } = await import('./hooks');

function Harness() {
  useConnectionUpdates();
  return (
    <>
      <OverviewPanel server={SERVER} core={SERVER.core!} />
      <ConfirmDialogHost />
    </>
  );
}

function renderPanel(bridge: Record<string, unknown> = {}, roles?: string[]) {
  return renderWithProviders(<Harness />, { bridge: { ...overviewBridge(roles), ...bridge } });
}

describe('OverviewPanel states', () => {
  it('shimmers while it finds out whether this computer is signed in', () => {
    renderPanel({ 'deploy.access': () => new Promise(() => undefined) });
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Pulse' })).toBeNull();
  });

  it('asks for a sign-in before showing anything live', async () => {
    renderPanel({ 'deploy.access': { state: 'needs-sign-in' } });
    expect(await screen.findByText(/Sign in to see Production live/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Pulse' })).toBeNull();
  });

  it('shows the pulse, the score, the facts, services, alerts and updates', async () => {
    const { bridge } = renderPanel();
    const pulse = await screen.findByRole('region', { name: 'Pulse' });
    await waitFor(() => expect(within(pulse).getByText(/Health score/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Health score \d+ of 100/ })).toBeInTheDocument();
    expect(await screen.findByText('AMD EPYC 7B13')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Services' })).toHaveTextContent('Docker');
    expect(screen.getByRole('list', { name: 'Updates' })).toHaveTextContent('openssl');
    expect(
      within(screen.getByRole('list', { name: 'Updates' })).getByText('Security'),
    ).toBeInTheDocument();
    expect(screen.getByText('/ is 91% full: 7.2 GB of 80 GB left.')).toBeInTheDocument();
    expect(bridge.$fn('deploySystem.watchMetrics')).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: SERVER.id,
        intervalMs: 2_000,
        sinceUnixMs: expect.any(Number),
      }),
    );
  });

  it('adds every live sample to the charts and the table', async () => {
    const { bridge, user } = renderPanel();
    await screen.findByRole('region', { name: 'Pulse' });
    await waitFor(() => expect(bridge.$listenerCount('deploySystem.onMetrics')).toBe(1));
    await user.click(await screen.findByRole('button', { name: 'Table' }));
    const rows = () => within(screen.getByRole('table', { name: 'Readings' })).getAllByRole('row');
    expect(rows()).toHaveLength(6);
    act(() =>
      bridge.$emit('deploySystem.onMetrics', {
        subscriptionId: 'metrics-1',
        serverId: SERVER.id,
        samples: [metricsSample(Date.now(), 9), metricsSample(Date.now() + 2_000, 10)],
      }),
    );
    expect(rows()).toHaveLength(8);
  });

  it('says so when the readings, facts and services do not load', async () => {
    const down = () => Promise.reject(new Error('The server core is not answering (503).'));
    renderPanel({
      'deploySystem.metricsHistory': down,
      'deploySystem.watchMetrics': down,
      'deploySystem.info': down,
      'deploySystem.services': down,
      'deploySystem.updates': down,
      'deployAlerts.list': down,
    });
    expect(
      await screen.findByText(/The readings did not load: The server core is not answering/),
    ).toBeInTheDocument();
    expect(screen.getByText(/The server's facts did not load/)).toBeInTheDocument();
    expect(screen.getByText(/The services did not load/)).toBeInTheDocument();
    expect(screen.getByText(/The updates did not load/)).toBeInTheDocument();
    expect(screen.getByText(/The alerts did not load/)).toBeInTheDocument();
  });

  it('says what an empty server looks like', async () => {
    renderPanel({
      'deploySystem.metricsHistory': { resolution: 'live', intervalSeconds: 2, samples: [] },
      'deploySystem.updates': sampleUpdates({ packages: [], securityCount: 0 }),
      'deployAlerts.list': [],
    });
    expect(
      await screen.findByText('Waiting for the first reading from the server.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Everything is up to date.')).toBeInTheDocument();
    expect(screen.getByText('No open alerts.')).toBeInTheDocument();
  });

  it('dims what it shows while the connection is tried again', async () => {
    const { bridge } = renderPanel();
    const services = await screen.findByRole('list', { name: 'Services' });
    act(() => bridge.$emit('deploy.onConnection', connection('reconnecting')));
    await waitFor(() => expect(services).toHaveClass('opacity-50'));
    act(() => bridge.$emit('deploy.onConnection', connection('online')));
    await waitFor(() => expect(services).not.toHaveClass('opacity-50'));
    await waitFor(() => expect(bridge.$fn('deploySystem.services')).toHaveBeenCalledTimes(2));
  });
});

describe('OverviewPanel roles', () => {
  it('lets a Viewer see everything and change nothing', async () => {
    renderPanel({}, ['viewer']);
    await screen.findByRole('list', { name: 'Updates' });
    expect(screen.queryByRole('button', { name: /Reboot/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Check for updates/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Install all/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Acknowledge/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Restart/ })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Automatic security updates' })).toBeDisabled();
    expect(screen.getByText(/Admins can change this/)).toBeInTheDocument();
  });

  it('lets an Admin switch automatic security updates', async () => {
    const { user, bridge } = renderPanel(
      {
        'deploySystem.setAutomaticUpdates': sampleJob({ kind: 'automaticUpdates' }),
      },
      ['admin'],
    );
    await user.click(await screen.findByRole('switch', { name: 'Automatic security updates' }));
    expect(bridge.$fn('deploySystem.setAutomaticUpdates')).toHaveBeenCalledWith(SERVER.id, true);
  });
});

describe('OverviewPanel actions', () => {
  it('previews the security updates, runs them and follows the log until done', async () => {
    const job = sampleJob();
    const { user, bridge } = renderPanel({ 'deploySystem.upgradeSecurity': job });
    await user.click(await screen.findByRole('button', { name: /Install security updates/ }));
    const preview = screen.getByRole('dialog', { name: 'Install the security updates?' });
    expect(within(preview).getByRole('list', { name: 'Packages to install' })).toHaveTextContent(
      'openssl',
    );
    expect(within(preview).queryByText('tzdata')).toBeNull();
    await user.click(within(preview).getByRole('button', { name: 'Install 1 update' }));

    const log = await screen.findByRole('dialog', { name: 'Install security updates' });
    await waitFor(() => expect(bridge.$listenerCount('deployJobs.onLog')).toBe(1));
    act(() =>
      bridge.$emit('deployJobs.onLog', {
        subscriptionId: 'log-1',
        serverId: SERVER.id,
        jobId: job.id,
        lines: [{ seq: 1, atUnixMs: 1, source: 'out', text: 'Unpacking openssl' }],
      }),
    );
    expect(within(log).getByRole('log')).toHaveTextContent('Unpacking openssl');
    await user.click(within(log).getByRole('button', { name: 'Cancel the job' }));
    expect(bridge.$fn('deployJobs.cancel')).toHaveBeenCalledWith(SERVER.id, job.id);
    act(() =>
      bridge.$emit('deployJobs.onLog', {
        subscriptionId: 'log-1',
        serverId: SERVER.id,
        jobId: job.id,
        lines: [],
        job: { ...job, state: 'cancelled' },
        ended: {},
      }),
    );
    expect(within(log).getByRole('status')).toHaveTextContent('Cancelled');
    expect(within(log).queryByRole('button', { name: 'Cancel the job' })).toBeNull();
    await waitFor(() => expect(bridge.$fn('deploySystem.updates')).toHaveBeenCalledTimes(2));
  });

  it('opens the update log again on return, and says it failed only once', async () => {
    const job = sampleJob();
    const failed = (bridge: ReturnType<typeof renderPanel>['bridge']) =>
      act(() =>
        bridge.$emit('deployJobs.onLog', {
          subscriptionId: 'log-1',
          serverId: SERVER.id,
          jobId: job.id,
          lines: [],
          job: { ...job, state: 'failed', error: 'dpkg was interrupted' },
          ended: {},
        }),
      );
    const first = renderPanel({ 'deploySystem.upgradeSecurity': job });
    await first.user.click(await screen.findByRole('button', { name: /Install security updates/ }));
    const preview = screen.getByRole('dialog', { name: 'Install the security updates?' });
    await first.user.click(within(preview).getByRole('button', { name: 'Install 1 update' }));
    await screen.findByRole('dialog', { name: 'Install security updates' });
    first.unmount();

    const again = renderPanel();
    await screen.findByRole('dialog', { name: 'Install security updates' });
    await waitFor(() => expect(again.bridge.$listenerCount('deployJobs.onLog')).toBe(1));
    failed(again.bridge);
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    again.unmount();

    const third = renderPanel();
    await screen.findByRole('dialog', { name: 'Install security updates' });
    await waitFor(() => expect(third.bridge.$listenerCount('deployJobs.onLog')).toBe(1));
    failed(third.bridge);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('asks for the password when every update needs a step-up, and tries again with it', async () => {
    const upgradeAll = vi
      .fn()
      .mockRejectedValueOnce(STEP_UP_REFUSAL)
      .mockRejectedValueOnce(new Error('[core:invalidCredentials] The password is not right.'))
      .mockResolvedValueOnce(sampleJob({ kind: 'packagesUpgrade', title: 'Install every update' }));
    const { user } = renderPanel({ 'deploySystem.upgradeAll': upgradeAll });
    await user.click(await screen.findByRole('button', { name: /Install all/ }));
    await user.click(screen.getByRole('button', { name: 'Install 2 updates' }));

    const proof = await screen.findByRole('dialog', { name: /Confirm it is you/ });
    expect(proof).toHaveTextContent('Installing every update on Production');
    await user.type(within(proof).getByLabelText('Password'), 'wrong');
    await user.click(within(proof).getByRole('button', { name: 'Confirm' }));
    expect(await within(proof).findByRole('alert')).toHaveTextContent('The password is not right.');
    await user.clear(within(proof).getByLabelText('Password'));
    await user.type(within(proof).getByLabelText('Password'), 'right');
    await user.click(within(proof).getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('dialog', { name: 'Install every update' })).toBeInTheDocument();
    expect(upgradeAll).toHaveBeenNthCalledWith(1, { serverId: SERVER.id });
    expect(upgradeAll).toHaveBeenLastCalledWith({ serverId: SERVER.id, password: 'right' });
  });

  it('does not ask for the password when this computer remembers it', async () => {
    const upgradeAll = vi
      .fn()
      .mockRejectedValueOnce(STEP_UP_REFUSAL)
      .mockResolvedValueOnce(sampleJob({ kind: 'packagesUpgrade', title: 'Install every update' }));
    const stepUpSaved = vi.fn(async () => ({ stepUpUntilUnixMs: Date.now() + 600_000 }));
    const { user } = renderPanel({
      'deploySystem.upgradeAll': upgradeAll,
      'deploy.stepUpSaved': stepUpSaved,
    });
    await user.click(await screen.findByRole('button', { name: /Install all/ }));
    await user.click(screen.getByRole('button', { name: 'Install 2 updates' }));

    expect(await screen.findByRole('dialog', { name: 'Install every update' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /Confirm it is you/ })).toBeNull();
    expect(stepUpSaved).toHaveBeenCalledWith(SERVER.id);
    expect(upgradeAll).toHaveBeenCalledTimes(2);
    expect(upgradeAll).toHaveBeenLastCalledWith({ serverId: SERVER.id });
  });

  it('asks for the password after all when the remembered one is not accepted', async () => {
    const upgradeAll = vi.fn().mockRejectedValue(STEP_UP_REFUSAL);
    const { user } = renderPanel({
      'deploySystem.upgradeAll': upgradeAll,
      'deploy.stepUpSaved': async () => null,
    });
    await user.click(await screen.findByRole('button', { name: /Install all/ }));
    await user.click(screen.getByRole('button', { name: 'Install 2 updates' }));

    expect(await screen.findByRole('dialog', { name: /Confirm it is you/ })).toBeInTheDocument();
    expect(upgradeAll).toHaveBeenCalledTimes(1);
  });

  it('remembers the password once the user ticks the box and it works', async () => {
    const upgradeAll = vi
      .fn()
      .mockRejectedValueOnce(STEP_UP_REFUSAL)
      .mockResolvedValueOnce(sampleJob({ kind: 'packagesUpgrade', title: 'Install every update' }));
    const rememberPassword = vi.fn(async () => undefined);
    const { user } = renderPanel({
      'deploySystem.upgradeAll': upgradeAll,
      'deploy.rememberPassword': rememberPassword,
    });
    await user.click(await screen.findByRole('button', { name: /Install all/ }));
    await user.click(screen.getByRole('button', { name: 'Install 2 updates' }));

    const proof = await screen.findByRole('dialog', { name: /Confirm it is you/ });
    const box = within(proof).getByRole('checkbox', { name: /Remember my password/ });
    expect(box).not.toBeChecked();
    await user.type(within(proof).getByLabelText('Password'), 'right');
    await user.click(box);
    await user.click(within(proof).getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('dialog', { name: 'Install every update' })).toBeInTheDocument();
    expect(rememberPassword).toHaveBeenCalledExactlyOnceWith({
      serverId: SERVER.id,
      password: 'right',
    });
  });

  it('does not remember a password that did not work', async () => {
    const upgradeAll = vi
      .fn()
      .mockRejectedValueOnce(STEP_UP_REFUSAL)
      .mockRejectedValueOnce(new Error('[core:invalidCredentials] The password is not right.'));
    const rememberPassword = vi.fn();
    const { user } = renderPanel({
      'deploySystem.upgradeAll': upgradeAll,
      'deploy.rememberPassword': rememberPassword,
    });
    await user.click(await screen.findByRole('button', { name: /Install all/ }));
    await user.click(screen.getByRole('button', { name: 'Install 2 updates' }));

    const proof = await screen.findByRole('dialog', { name: /Confirm it is you/ });
    await user.type(within(proof).getByLabelText('Password'), 'wrong');
    await user.click(within(proof).getByRole('checkbox', { name: /Remember my password/ }));
    await user.click(within(proof).getByRole('button', { name: 'Confirm' }));

    expect(await within(proof).findByRole('alert')).toHaveTextContent('The password is not right.');
    expect(rememberPassword).not.toHaveBeenCalled();
  });

  it('turns away a role refusal with its words, without asking for a password', async () => {
    const { user } = renderPanel({
      'deploySystem.upgradeAll': () =>
        Promise.reject(new Error('[core:forbidden] Your role cannot do that.')),
    });
    await user.click(await screen.findByRole('button', { name: /Install all/ }));
    await user.click(screen.getByRole('button', { name: 'Install 2 updates' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Your role cannot do that.'));
    expect(screen.queryByRole('dialog', { name: /Confirm it is you/ })).toBeNull();
  });

  it('reboots after the name is typed, waits for the server and says when it is back', async () => {
    const reboot = vi.fn().mockResolvedValue(sampleJob({ kind: 'reboot', title: 'Reboot' }));
    const { user, bridge } = renderPanel({ 'deploySystem.reboot': reboot });
    await user.click(await screen.findByRole('button', { name: 'Reboot' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reboot Production?' });
    const go = within(confirm).getByRole('button', { name: 'Reboot' });
    expect(go).toBeDisabled();
    await user.type(within(confirm).getByLabelText(/to confirm/), 'Production');
    await user.click(go);

    expect(await screen.findByText(/Production is about to reboot/)).toBeInTheDocument();
    expect(reboot).toHaveBeenCalledWith({ serverId: SERVER.id });
    expect(screen.getByRole('button', { name: 'Reboot' })).toBeDisabled();
    act(() => bridge.$emit('deploy.onConnection', connection('reconnecting')));
    expect(await screen.findByText(/Waiting for Production to come back/)).toBeInTheDocument();
    act(() => bridge.$emit('deploy.onConnection', connection('online')));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Production is back.'));
    // The toast and the cleared banner come from the same effect, so the banner is still on
    // screen when the toast fires and leaves with the next render.
    await waitFor(() => expect(screen.queryByText(/Waiting for Production/)).toBeNull());
  });

  it('checks for updates quietly and reads the list again when the check is done', async () => {
    const job = sampleJob({ kind: 'packagesRefresh', title: 'Check for updates' });
    const { user, bridge } = renderPanel({ 'deploySystem.checkUpdates': job });
    await screen.findByRole('list', { name: 'Updates' });
    await user.click(await screen.findByRole('button', { name: /Check for updates/ }));
    expect(await screen.findByRole('button', { name: /Checking/ })).toBeDisabled();
    await waitFor(() => expect(bridge.$listenerCount('deployJobs.onLog')).toBe(1));
    act(() =>
      bridge.$emit('deployJobs.onLog', {
        subscriptionId: 'log-1',
        serverId: SERVER.id,
        jobId: job.id,
        lines: [],
        job: { ...job, state: 'failed', error: 'apt is busy' },
        ended: {},
      }),
    );
    await waitFor(() => expect(bridge.$fn('deploySystem.updates')).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenCalledWith('Check for updates failed: apt is busy');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('restarts Docker and shows its log, and acknowledges an alert', async () => {
    const acknowledged = sampleAlert({
      revision: 2,
      acknowledgedAtUnixMs: Date.now(),
      acknowledgedBy: 'maria',
    });
    const { user, bridge } = renderPanel({
      'deploySystem.restartService': sampleJob({ kind: 'serviceRestart', title: 'Restart Docker' }),
      'deployAlerts.acknowledge': acknowledged,
    });
    await user.click(await screen.findByRole('button', { name: 'Restart Docker' }));
    expect(bridge.$fn('deploySystem.restartService')).toHaveBeenCalledWith(SERVER.id, 'docker');
    const log = await screen.findByRole('dialog', { name: 'Restart Docker' });
    await user.click(within(log).getAllByRole('button', { name: 'Close' })[0]);

    await user.click(screen.getByRole('button', { name: /Acknowledge/ }));
    expect(await screen.findByText('Acknowledged by maria')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Acknowledge/ })).toBeNull();
  });

  it('points at a job someone else started, and opens its log', async () => {
    const { user } = renderPanel({
      'deployJobs.list': {
        jobs: [sampleJob({ title: 'Install security updates', requestedBy: 'sam' })],
      },
    });
    expect(
      await screen.findByText('Running: Install security updates, started by sam'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Install all/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Show the log' }));
    expect(
      await screen.findByRole('dialog', { name: 'Install security updates' }),
    ).toBeInTheDocument();
  });
});
