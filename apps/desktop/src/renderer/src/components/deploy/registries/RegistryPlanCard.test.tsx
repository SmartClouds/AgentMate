import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import type { FakeBridge } from '../../../../../test/renderer/runovaBridge';

/** Which sign-in goes with an app's deploys (E08 T6), in words, and the per-app choice. */

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const { RegistryPlanCard } = await import('./RegistryPlanCard');

const STACK = '33333333-3333-4333-8333-333333333333';
const CREDENTIAL = '11111111-1111-4111-8111-111111111111';

describe('RegistryPlanCard', () => {
  it('says what signs in to each registry, never by colour alone', async () => {
    renderWithProviders(
      <RegistryPlanCard
        input={{ serverId: 'srv-1', stackId: STACK, revision: 2 }}
        stackId={STACK}
      />,
      {
        bridge: {
          'deployRegistry.plan': {
            sendSignIns: true,
            entries: [
              { registry: 'docker.io', credentialId: null, storedOnServer: true },
              { registry: 'ghcr.io', credentialId: CREDENTIAL, storedOnServer: false },
              { registry: 'quay.io', credentialId: null, storedOnServer: false },
            ],
          },
        },
      },
    );
    const list = await screen.findByRole('list', { name: 'Registries this app pulls from' });
    expect(within(list).getByRole('listitem', { name: 'Docker Hub' })).toHaveTextContent(
      /stored on this server/,
    );
    expect(
      within(list).getByRole('listitem', { name: 'GitHub Container Registry' }),
    ).toHaveTextContent(/from this computer goes with the deploy/);
    expect(within(list).getByRole('listitem', { name: 'quay.io' })).toHaveTextContent(
      /fails unless the images are public/,
    );
  });

  it("turns the app's choice off", async () => {
    const user = userEvent.setup();
    const { bridge } = renderWithProviders(
      <RegistryPlanCard
        input={{ serverId: 'srv-1', stackId: STACK, revision: 2 }}
        stackId={STACK}
      />,
      {
        bridge: {
          'deployRegistry.plan': {
            sendSignIns: true,
            entries: [{ registry: 'ghcr.io', credentialId: CREDENTIAL, storedOnServer: false }],
          },
        },
      },
    );
    const toggle = await screen.findByRole('switch', {
      name: "Send this computer's sign-ins with this app's deploys",
    });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() =>
      expect((bridge as FakeBridge).$fn('deployRegistry.setAppChoice')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        stackId: STACK,
        sendSignIns: false,
      }),
    );
  });

  it('stays out of the way in the wizard when only public Docker Hub images pull', async () => {
    const { bridge } = renderWithProviders(
      <RegistryPlanCard input={{ serverId: 'srv-1', images: ['nginx:1.29'] }} stackId={null} />,
      {
        bridge: {
          'deployRegistry.plan': {
            sendSignIns: true,
            entries: [{ registry: 'docker.io', credentialId: null, storedOnServer: false }],
          },
        },
      },
    );
    await waitFor(() =>
      expect((bridge as FakeBridge).$fn('deployRegistry.plan')).toHaveBeenCalled(),
    );
    expect(screen.queryByRole('region', { name: 'Registry sign-in' })).toBeNull();
  });

  it('shimmers while it works the plan out', async () => {
    renderWithProviders(
      <RegistryPlanCard input={{ serverId: 'srv-1', images: ['ghcr.io/a/b'] }} stackId={null} />,
      { bridge: { 'deployRegistry.plan': () => new Promise(() => undefined) } },
    );
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
  });

  it('says when the plan could not be worked out', async () => {
    renderWithProviders(
      <RegistryPlanCard
        input={{ serverId: 'srv-1', stackId: STACK, revision: 9 }}
        stackId={STACK}
      />,
      {
        bridge: {
          'deployRegistry.plan': () => Promise.reject(new Error('There is no such revision.')),
        },
      },
    );
    expect(
      await screen.findByText(/could not be worked out: There is no such revision/),
    ).toBeVisible();
  });

  it('an app that only builds says nothing pulls', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    renderWithProviders(
      <RegistryPlanCard
        input={{ serverId: 'srv-1', stackId: STACK, revision: 1 }}
        stackId={STACK}
        onOpenRegistries={open}
      />,
      { bridge: { 'deployRegistry.plan': { sendSignIns: false, entries: [] } } },
    );
    expect(await screen.findByText(/nothing pulls/)).toBeVisible();
    expect(screen.getByRole('switch')).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Manage registries' }));
    expect(open).toHaveBeenCalled();
  });
});
