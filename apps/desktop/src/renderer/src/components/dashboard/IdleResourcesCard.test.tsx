import type { ActivityResource, ResourceActivitySnapshot } from '@runova/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfirm, useConfirmStore } from '@/stores/confirmStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { IdleResourcesCard } from './IdleResourcesCard';

/**
 * The list is the part of this feature people act on, so the tests cover what it says when there
 * is nothing to act on, that a stop goes to the right resource, and that "stop all" asks first
 * and tells the main process to leave out anything that has become busy again.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const MIN = 60_000;

function resource(overrides: Partial<ActivityResource> = {}): ActivityResource {
  return {
    key: 'docker:c1',
    kind: 'docker',
    id: 'c1',
    name: 'postgres',
    detail: 'postgres:16',
    cpuPercent: 0.4,
    memBytes: 40 * 1024 ** 2,
    measurable: true,
    firstSeenAt: 0,
    lastActiveAt: 0,
    idleForMs: 25 * MIN,
    idle: true,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ResourceActivitySnapshot> = {}): ResourceActivitySnapshot {
  return {
    generatedAt: 10_000_000,
    // Watched for far longer than the threshold, so the "still watching" note stays out of the way.
    watchingSince: 0,
    idleMinutes: 20,
    docker: 'ready',
    emulators: 'ready',
    resources: [],
    history: [],
    ...overrides,
  };
}

const SETTINGS = { idleResourceMinutes: 20, idleResourceNotify: true };

function renderCard(
  data: ResourceActivitySnapshot | Promise<ResourceActivitySnapshot>,
  bridge: Record<string, unknown> = {},
  props: { onRemove?: () => void } = {},
) {
  return renderWithProviders(<IdleResourcesCard chartHeight={88} {...props} />, {
    bridge: {
      'resourceActivity.snapshot': () => Promise.resolve(data),
      'settings.get': SETTINGS,
      'settings.update': async (patch: object) => ({ ...SETTINGS, ...patch }),
      ...bridge,
    },
  });
}

const THREE = [
  resource({ key: 'docker:a', id: 'a', name: 'db', idleForMs: 45 * MIN }),
  resource({ key: 'docker:b', id: 'b', name: 'redis', detail: 'redis:7', idleForMs: 30 * MIN }),
  resource({
    key: 'emulator:emulator-5554',
    kind: 'emulator',
    id: 'emulator-5554',
    name: 'Pixel_7',
    detail: 'emulator-5554',
    idleForMs: 22 * MIN,
  }),
];

beforeEach(() => {
  for (const fn of [toast.success, toast.error, toast.info]) fn.mockReset();
  resolveConfirm(false);
});

describe('IdleResourcesCard loading and empty states', () => {
  it('shimmers while the first reading is on its way, instead of claiming nothing is running', () => {
    const { container } = renderCard(new Promise(() => undefined));

    expect(container.querySelectorAll('.shimmer').length).toBeGreaterThan(0);
    expect(screen.queryByText('Nothing is running.')).toBeNull();
  });

  it('says nothing is running when it is not', async () => {
    renderCard(snapshot());
    expect(await screen.findByText('Nothing is running.')).toBeTruthy();
  });

  it('says Docker is not running when that is the reason', async () => {
    renderCard(snapshot({ docker: 'unavailable' }));
    expect(await screen.findByText('Docker is not running.')).toBeTruthy();
  });

  it('says nothing is idle, and for how long things were checked', async () => {
    renderCard(
      snapshot({
        resources: [resource({ idle: false, idleForMs: 2 * MIN })],
      }),
    );

    expect(
      await screen.findByText('Nothing idle. Everything running was active in the last 20 min.'),
    ).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.getByText('idle of 1 running')).toBeTruthy();
  });

  it('says it could not read the numbers when the main process fails', async () => {
    renderCard(Promise.reject(new Error('boom')));
    expect(await screen.findByText('Could not read Docker and emulator usage.')).toBeTruthy();
  });

  it('notes that the idle clocks are still young right after launch', async () => {
    renderCard(snapshot({ generatedAt: 4 * MIN, watchingSince: 0, resources: [resource()] }));
    expect(await screen.findByText(/watching for 4 min/)).toBeTruthy();
  });

  it('explains the emulators it cannot measure and a Docker that is down', async () => {
    renderCard(
      snapshot({
        docker: 'unavailable',
        resources: [
          resource({
            key: 'emulator:e',
            kind: 'emulator',
            id: 'e',
            name: 'Pixel',
            measurable: false,
            idle: false,
            idleForMs: 0,
          }),
        ],
      }),
    );

    const note = await screen.findByText(/can't be measured/);
    expect(note.textContent).toContain('Docker is not running');
    expect(note.textContent).toContain("1 emulator can't be measured");
  });
});

describe('IdleResourcesCard list', () => {
  it('lists only the idle ones, with how long each has been quiet', async () => {
    renderCard(
      snapshot({
        resources: [...THREE, resource({ key: 'docker:z', id: 'z', name: 'busy', idle: false })],
      }),
    );

    expect(await screen.findByText('db')).toBeTruthy();
    expect(screen.getByText('redis')).toBeTruthy();
    expect(screen.getByText('Pixel_7')).toBeTruthy();
    expect(screen.queryByText('busy')).toBeNull();
    expect(screen.getByText('idle 45 min')).toBeTruthy();
    expect(screen.getByText('idle 22 min')).toBeTruthy();
    expect(screen.getByText('idle of 4 running')).toBeTruthy();
  });

  it('writes long idle times in hours', async () => {
    renderCard(snapshot({ resources: [resource({ idleForMs: 65 * MIN })] }));
    expect(await screen.findByText('idle 1 h 5 min')).toBeTruthy();
  });

  it('offers Remove only when the dashboard is being edited', async () => {
    const onRemove = vi.fn();
    const { user, unmount } = renderCard(snapshot(), {}, { onRemove });

    await user.click(await screen.findByRole('button', { name: 'Remove from dashboard' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    unmount();

    renderCard(snapshot());
    await screen.findByText('Nothing is running.');
    expect(screen.queryByRole('button', { name: 'Remove from dashboard' })).toBeNull();
  });
});

describe('IdleResourcesCard stopping', () => {
  function stopOutcome(stoppedKey: string, remaining: ActivityResource[]) {
    return {
      results: [
        {
          ref: { kind: stoppedKey.startsWith('emulator') ? 'emulator' : 'docker', id: 'x' },
          name: 'db',
          ok: true,
        },
      ],
      snapshot: snapshot({ resources: remaining }),
    };
  }

  it('stops one resource straight away and drops it from the list', async () => {
    const stop = vi.fn(async () => stopOutcome('docker:a', THREE.slice(1)));
    const { user } = renderCard(snapshot({ resources: THREE }), { 'resourceActivity.stop': stop });

    await user.click(await screen.findByRole('button', { name: 'Stop db' }));

    expect(stop).toHaveBeenCalledWith([{ kind: 'docker', id: 'a' }], { onlyIfIdle: false });
    await waitFor(() => expect(screen.queryByText('db')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('Stopped db.');
  });

  it('stops an emulator by its serial', async () => {
    const stop = vi.fn(async () => stopOutcome('emulator', THREE.slice(0, 2)));
    const { user } = renderCard(snapshot({ resources: THREE }), { 'resourceActivity.stop': stop });

    await user.click(await screen.findByRole('button', { name: 'Stop Pixel_7' }));

    expect(stop).toHaveBeenCalledWith([{ kind: 'emulator', id: 'emulator-5554' }], {
      onlyIfIdle: false,
    });
  });

  it('reports why a stop failed and keeps the row', async () => {
    const stop = vi.fn(async () => ({
      results: [
        { ref: { kind: 'docker', id: 'a' }, name: 'db', ok: false, message: 'permission denied' },
      ],
      snapshot: snapshot({ resources: THREE }),
    }));
    const { user } = renderCard(snapshot({ resources: THREE }), { 'resourceActivity.stop': stop });

    await user.click(await screen.findByRole('button', { name: 'Stop db' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not stop db: permission denied'),
    );
    expect(screen.getByText('db')).toBeTruthy();
  });

  it('tells the user when the stop call itself fails', async () => {
    const stop = vi.fn(() => Promise.reject(new Error('ipc closed')));
    const { user } = renderCard(snapshot({ resources: THREE }), { 'resourceActivity.stop': stop });

    await user.click(await screen.findByRole('button', { name: 'Stop db' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not stop that.'));
  });

  it('offers Stop all idle only when there is more than one', async () => {
    renderCard(snapshot({ resources: [THREE[0] as ActivityResource] }));
    await screen.findByText('db');
    expect(screen.queryByRole('button', { name: 'Stop all idle' })).toBeNull();
  });

  it('asks first, lists what will stop, then stops only the ones still idle', async () => {
    const stop = vi.fn(async () => ({
      results: THREE.map((one) => ({
        ref: { kind: one.kind, id: one.id },
        name: one.name,
        ok: true,
      })),
      snapshot: snapshot(),
    }));
    const { user } = renderCard(snapshot({ resources: THREE }), { 'resourceActivity.stop': stop });

    await user.click(await screen.findByRole('button', { name: 'Stop all idle' }));

    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    const asked = useConfirmStore.getState();
    expect(asked.title).toBe('Stop 3 idle items?');
    expect(asked.items?.map((one) => one.name)).toEqual(['db', 'redis', 'Pixel_7']);
    expect(asked.variant).toBe('destructive');
    // Nothing has been stopped yet.
    expect(stop).not.toHaveBeenCalled();

    resolveConfirm(true);

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(stop).toHaveBeenCalledWith(
      [
        { kind: 'docker', id: 'a' },
        { kind: 'docker', id: 'b' },
        { kind: 'emulator', id: 'emulator-5554' },
      ],
      { onlyIfIdle: true },
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Stopped 3 idle items.'));
  });

  it('stops nothing when the question is declined', async () => {
    const stop = vi.fn();
    const { user } = renderCard(snapshot({ resources: THREE }), { 'resourceActivity.stop': stop });

    await user.click(await screen.findByRole('button', { name: 'Stop all idle' }));
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    resolveConfirm(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stop).not.toHaveBeenCalled();
  });

  it('says so when something became busy and was left running', async () => {
    const stop = vi.fn(async () => ({
      results: [
        { ref: { kind: 'docker', id: 'a' }, name: 'db', ok: true },
        { ref: { kind: 'docker', id: 'b' }, name: 'redis', ok: false, skipped: 'active' },
      ],
      snapshot: snapshot({ resources: [THREE[1] as ActivityResource] }),
    }));
    const { user } = renderCard(snapshot({ resources: THREE.slice(0, 2) }), {
      'resourceActivity.stop': stop,
    });

    await user.click(await screen.findByRole('button', { name: 'Stop all idle' }));
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    resolveConfirm(true);

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Stopped db. 1 became active again, so it was left running.',
      ),
    );
  });
});

describe('IdleResourcesCard settings and refresh', () => {
  async function openSettings(user: UserEvent): Promise<void> {
    await user.click(await screen.findByRole('button', { name: 'Idle settings' }));
  }

  it('shows the saved threshold and saves a new one', async () => {
    const { user, bridge } = renderCard(snapshot());
    await openSettings(user);

    const input = (await screen.findByLabelText('List as idle after')) as HTMLInputElement;
    expect(input.value).toBe('20');
    fireEvent.change(input, { target: { value: '45' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ idleResourceMinutes: 45 }),
    );
  });

  it('clamps a threshold past the limits instead of saving nonsense', async () => {
    const { user, bridge } = renderCard(snapshot());
    await openSettings(user);
    const input = (await screen.findByLabelText('List as idle after')) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '99999' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        idleResourceMinutes: 1440,
      }),
    );
  });

  it('does not save when the value did not change', async () => {
    const { user, bridge } = renderCard(snapshot());
    await openSettings(user);
    const input = (await screen.findByLabelText('List as idle after')) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.blur(input);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => bridge.$fn('settings.update')).toThrow();
  });

  it('turns the alert on and off', async () => {
    const { user, bridge } = renderCard(snapshot());
    await openSettings(user);

    const toggle = await screen.findByRole('switch', {
      name: 'Notify me when something goes idle',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ idleResourceNotify: false }),
    );
  });

  it('checks again on demand, asking the main process for a fresh reading', async () => {
    const { user, bridge } = renderCard(snapshot());
    await screen.findByText('Nothing is running.');

    await user.click(screen.getByRole('button', { name: 'Check again now' }));

    await waitFor(() =>
      expect(bridge.$fn('resourceActivity.snapshot')).toHaveBeenCalledWith({ fresh: true }),
    );
  });
});

describe('IdleResourcesCard rows', () => {
  it('keeps a stopping row from being stopped twice', async () => {
    let finish: (() => void) | undefined;
    const stop = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              results: [{ ref: { kind: 'docker', id: 'a' }, name: 'db', ok: true }],
              snapshot: snapshot(),
            });
        }),
    );
    const { user } = renderCard(snapshot({ resources: THREE }), { 'resourceActivity.stop': stop });

    const button = await screen.findByRole('button', { name: 'Stop db' });
    await user.click(button);

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    await user.click(button);
    expect(stop).toHaveBeenCalledTimes(1);

    finish?.();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('has a row per idle resource inside the list', async () => {
    renderCard(snapshot({ resources: THREE }));
    const row = (await screen.findByText('db')).closest('div');
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).getByText('idle 45 min')).toBeTruthy();
  });
});
