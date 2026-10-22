import { encodeCoreError } from '@shared/coreErrors';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { sampleDetails, sampleJob, sampleRevision } from '../apps/testing/fixtures';
import { installedCompose, SERVER, STACK_ID, storeBridge, storeDetails } from './testing/fixtures';

/**
 * One installed app later on: the card masks every password, reveals them for an Admin after a
 * step-up (an Operator is told who can), offers the updates the catalog has (newer images for the
 * same line, or a newer line) as new revisions, and rolls back.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { AppStorePanel } = await import('./AppStorePanel');

beforeEach(() => {
  confirm.mockClear();
  confirm.mockImplementation(async () => true);
});

const appRoute = `/deploy?server=${SERVER.id}&view=store&app=${STACK_ID}`;

function renderApp(bridge: Record<string, unknown> = {}, roles = ['owner']) {
  return renderWithProviders(<AppStorePanel server={SERVER} />, {
    bridge: { ...storeBridge(roles), ...bridge },
    route: appRoute,
  });
}

function postgresAt(version: string, digest?: string) {
  const installed = installedCompose('postgres', { version, params: { port: 15440 } });
  const compose = digest
    ? installed.compose.replace(/@sha256:[0-9a-f]{64}/, `@sha256:${digest}`)
    : installed.compose;
  const envKeys = Object.keys(installed.env);
  return {
    'deployStacks.get': storeDetails('db', envKeys),
    'deployStacks.files': { number: 2, compose, envKeys },
  };
}

describe('the post-install card', () => {
  it('masks the passwords and says who can reveal them', async () => {
    renderApp({}, ['operator']);
    const card = await screen.findByRole('list', { name: 'Connection details' });
    expect(within(card).getByText('redis://:********@127.0.0.1:16379/0')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Copy Connection string' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(card).getByRole('button', { name: 'Copy Host' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByText('Only an Admin can reveal the passwords.')).toBeTruthy();
    expect(screen.getByText(/Up to date: it runs the images the App Store pins/)).toBeTruthy();
  });

  it('reveals them for an Admin after a step-up', async () => {
    let stepped = false;
    const reveal = vi.fn(async (input: { password?: string }) => {
      if (!input.password && !stepped) {
        throw new Error(encodeCoreError('stepUpRequired', 'Confirm your password.'));
      }
      stepped = true;
      return { REDIS_PASSWORD: 'Revealed1234567890abcd' };
    });
    const { user } = renderApp({ 'deployAppStore.revealSecrets': reveal });
    await user.click(await screen.findByRole('button', { name: 'Reveal passwords' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Password/), 'hunter2hunter2');
    await user.click(within(dialog).getByRole('button', { name: /Confirm|Continue/ }));
    const card = await screen.findByRole('list', { name: 'Connection details' });
    expect(
      await within(card).findByText('redis://:Revealed1234567890abcd@127.0.0.1:16379/0'),
    ).toBeTruthy();
    expect(reveal).toHaveBeenLastCalledWith({
      serverId: SERVER.id,
      stackId: STACK_ID,
      revision: 2,
      password: 'hunter2hunter2',
    });
  });

  it('offers a newer release line and moves to it as a new revision', async () => {
    const update = vi.fn(async () => ({
      revision: sampleRevision({ number: 3, state: 'deploying' }),
      job: sampleJob(),
    }));
    const { user } = renderApp({ ...postgresAt('17'), 'deployAppStore.update': update });
    const updates = await screen.findByRole('region', { name: 'Updates' });
    expect(within(updates).getByText('PostgreSQL 18 is available.')).toBeTruthy();
    await user.click(within(updates).getByRole('button', { name: 'Move to PostgreSQL 18' }));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Move to PostgreSQL 18?', warning: expect.any(String) }),
    );
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        serverId: SERVER.id,
        stackId: STACK_ID,
        version: '18',
      }),
    );
  });

  it('offers newer images for the same line, showing the digests', async () => {
    const update = vi.fn(async () => ({ revision: sampleRevision({ number: 3 }), job: null }));
    const { user } = renderApp({
      ...postgresAt('18', '0'.repeat(64)),
      'deployAppStore.update': update,
    });
    const updates = await screen.findByRole('region', { name: 'Updates' });
    expect(within(updates).getByText(/Newer images for PostgreSQL 18/)).toBeTruthy();
    expect(within(updates).getByText(/db: 000000000000 to/)).toBeTruthy();
    await user.click(within(updates).getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        serverId: SERVER.id,
        stackId: STACK_ID,
        version: '18',
      }),
    );
    // The server made the revision but did not deploy it: the screen says why.
    expect(await screen.findByText(/Revision 3 waits for findings/)).toBeTruthy();
  });

  it('leaves the app alone when the update is turned down, and says a refusal', async () => {
    confirm.mockImplementation(async () => false);
    const update = vi.fn(async () => {
      throw new Error('This version reads NEW_KEY, which db was not installed with.');
    });
    const { user } = renderApp({ ...postgresAt('17'), 'deployAppStore.update': update });
    const updates = await screen.findByRole('region', { name: 'Updates' });
    await user.click(within(updates).getByRole('button', { name: 'Move to PostgreSQL 18' }));
    expect(update).not.toHaveBeenCalled();
    confirm.mockImplementation(async () => true);
    await user.click(within(updates).getByRole('button', { name: 'Move to PostgreSQL 18' }));
    expect(await screen.findByText(/NEW_KEY, which db was not installed with/)).toBeTruthy();
  });

  it('rolls back to the revision before', async () => {
    const rollback = vi.fn(async () => sampleJob());
    const { user } = renderApp({ 'deployStacks.rollback': rollback });
    await user.click(await screen.findByRole('button', { name: 'Roll back to revision 1' }));
    await waitFor(() =>
      expect(rollback).toHaveBeenCalledWith({
        serverId: SERVER.id,
        stackId: STACK_ID,
        revision: 1,
      }),
    );
  });

  it('says so when an app is not from the App Store, or does not load', async () => {
    const view = renderApp({
      'deployStacks.files': { number: 2, compose: 'services: {}\n', envKeys: [] },
    });
    expect(await screen.findByText('This app was not installed from the App Store.')).toBeTruthy();
    view.unmount();
    renderApp({
      'deployStacks.get': async () => {
        throw new Error('The core is not answering.');
      },
    });
    expect(await screen.findByText(/The app did not load: The core is not answering/)).toBeTruthy();
  });
});

describe('logs and consoles of an installed app', () => {
  it('waits for something to run before it offers logs or a console', async () => {
    renderApp();
    await screen.findByRole('list', { name: 'Connection details' });
    expect(screen.getByRole('button', { name: 'Logs' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Console' })).toBeDisabled();
  });

  it('opens the sheet on every service, and keeps the console from an Operator', async () => {
    const running = {
      ...storeDetails('cache', []),
      services: sampleDetails().services,
    };
    const { user } = renderApp(
      {
        'deployStacks.get': running,
        'deployDocker.watchLogs': async () => 'logs-1',
        'deployDocker.unwatchLogs': async () => true,
      },
      ['operator'],
    );
    await screen.findByRole('list', { name: 'Connection details' });
    expect(screen.getByRole('button', { name: 'Console' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Logs' }));
    const sheet = await screen.findByRole('dialog', { name: 'cache' });
    expect(within(sheet).getByRole('log', { name: 'Log: cache' })).toBeInTheDocument();
  });
});
