// @vitest-environment jsdom

import type { AppNotification } from '@runova/core';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastHistoryStore } from '@/stores/toastHistoryStore';
import { useAppNotificationMessages } from './useAppNotificationMessages';

const toastFns = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  message: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toastFns }));

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    kind: 'pipeline-failure',
    title: 'CI failed',
    body: 'Demo · main · run #42',
    projectId: 'p1',
    projectName: 'Demo',
    htmlUrl: 'https://github.com/acme/demo/actions/runs/123',
    createdAt: new Date().toISOString(),
    read: false,
    ...overrides,
  };
}

let inbox: AppNotification[] = [];
let changed: (() => void) | null = null;
let savedSettings: Record<string, unknown> = {};

function Probe(): React.JSX.Element {
  useAppNotificationMessages();
  const { pathname, search } = useLocation();
  return <span data-testid="location">{`${pathname}${search}`}</span>;
}

async function mount(): Promise<void> {
  render(
    <MemoryRouter>
      <Probe />
    </MemoryRouter>,
  );
  await act(async () => undefined);
}

async function inboxChanged(next: AppNotification[]): Promise<void> {
  inbox = next;
  await act(async () => {
    changed?.();
  });
}

beforeEach(() => {
  inbox = [];
  changed = null;
  savedSettings = {};
  useToastHistoryStore.setState({ items: [], open: false });
  for (const fn of Object.values(toastFns)) fn.mockReset();
  Object.assign(window, {
    runova: {
      settings: { get: vi.fn(async () => savedSettings) },
      shell: { openExternal: vi.fn(async () => undefined) },
      appNotifications: {
        list: vi.fn(async () => inbox),
        markRead: vi.fn(async () => []),
        onChanged: (callback: () => void) => {
          changed = callback;
          return () => {
            changed = null;
          };
        },
      },
    },
  });
});

afterEach(cleanup);

describe('useAppNotificationMessages', () => {
  it('leaves what was already in the inbox at startup alone', async () => {
    inbox = [notification()];
    await mount();
    expect(toastFns.error).not.toHaveBeenCalled();
    expect(useToastHistoryStore.getState().items).toEqual([]);
  });

  it('flashes a colored toast and files a linked row in history for a new failure', async () => {
    await mount();
    await inboxChanged([notification()]);

    expect(toastFns.error).toHaveBeenCalledTimes(1);
    const [title, options] = toastFns.error.mock.calls[0];
    expect(title).toBe('CI failed');
    expect(options.action.label).toBe('Open');

    const items = useToastHistoryStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'error',
      tag: 'Failed',
      projectId: 'p1',
      link: { route: '/pipelines?run=123&repo=acme%2Fdemo', notificationId: 'n1' },
    });
  });

  it('calls a passing run success, and only announces each entry once', async () => {
    await mount();
    const pass = notification({ id: 'n2', kind: 'pipeline-success', title: 'CI passed' });
    await inboxChanged([pass]);
    await inboxChanged([pass]);

    expect(toastFns.success).toHaveBeenCalledTimes(1);
    expect(useToastHistoryStore.getState().items[0]).toMatchObject({ tag: 'Passed' });
  });

  it('opens the run in the app from the toast button and marks it read', async () => {
    await mount();
    await inboxChanged([notification()]);

    const options = toastFns.error.mock.calls[0][1];
    await act(async () => options.action.onClick());

    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe(
      '/pipelines?run=123&repo=acme%2Fdemo',
    );
    expect(window.runova.appNotifications.markRead).toHaveBeenCalledWith('n1');
    expect(window.runova.shell.openExternal).not.toHaveBeenCalled();
  });

  describe('when clicking a failure should open the project workspace', () => {
    beforeEach(() => {
      savedSettings = { pipelineFailureOpen: 'workspace' };
    });

    it("opens the Pipelines section of that project's workspace and marks it read", async () => {
      await mount();
      await inboxChanged([notification()]);

      const options = toastFns.error.mock.calls[0][1];
      expect(options.action.label).toBe('Open');
      await act(async () => options.action.onClick());

      expect(document.querySelector('[data-testid="location"]')?.textContent).toBe(
        '/workspace/p1?panel=pipelines',
      );
      expect(window.runova.appNotifications.markRead).toHaveBeenCalledWith('n1');
      // The row in Recent messages opens the same place.
      expect(useToastHistoryStore.getState().items[0].link).toEqual({
        route: '/workspace/p1?panel=pipelines',
        notificationId: 'n1',
      });
    });

    it('falls back to the run on the Pipelines page when the alert has no project', async () => {
      await mount();
      await inboxChanged([notification({ projectId: null })]);

      await act(async () => toastFns.error.mock.calls[0][1].action.onClick());

      expect(document.querySelector('[data-testid="location"]')?.textContent).toBe(
        '/pipelines?run=123&repo=acme%2Fdemo',
      );
    });

    it('leaves a pass and a server alert where they were', async () => {
      await mount();
      await inboxChanged([
        notification({ id: 'n2', kind: 'pipeline-success', title: 'CI passed' }),
        notification({
          id: 'n3',
          kind: 'deploy-warning',
          htmlUrl: null,
          route: '/deploy?server=srv-1',
        }),
      ]);

      await act(async () => toastFns.success.mock.calls[0][1].action.onClick());
      expect(document.querySelector('[data-testid="location"]')?.textContent).toBe(
        '/pipelines?run=123&repo=acme%2Fdemo',
      );
      await act(async () => toastFns.warning.mock.calls[0][1].action.onClick());
      expect(document.querySelector('[data-testid="location"]')?.textContent).toBe(
        '/deploy?server=srv-1',
      );
    });
  });

  describe('when clicking a failure should not open it', () => {
    it('flashes the failure with no Open button and files a row with nothing to open', async () => {
      savedSettings = { pipelineFailureOpen: 'none' };
      await mount();
      await inboxChanged([notification()]);

      expect(toastFns.error).toHaveBeenCalledTimes(1);
      const [title, options] = toastFns.error.mock.calls[0];
      expect(title).toBe('CI failed');
      expect(options.action).toBeUndefined();

      const items = useToastHistoryStore.getState().items;
      expect(items).toHaveLength(1);
      // Still a red, tagged row for the right project, only the link is gone.
      expect(items[0]).toMatchObject({ kind: 'error', tag: 'Failed', projectId: 'p1' });
      expect(items[0].link).toBeUndefined();
      expect(window.runova.shell.openExternal).not.toHaveBeenCalled();
    });

    it('leaves a pass and a server alert linked', async () => {
      savedSettings = { pipelineFailureOpen: 'none' };
      await mount();
      await inboxChanged([
        notification({ id: 'n2', kind: 'pipeline-success', title: 'CI passed' }),
        notification({
          id: 'n3',
          kind: 'deploy-warning',
          htmlUrl: null,
          route: '/deploy?server=srv-1',
        }),
      ]);

      expect(toastFns.success.mock.calls[0][1].action.label).toBe('Open');
      expect(toastFns.warning.mock.calls[0][1].action.label).toBe('Open');
    });

    it('keeps the link when the setting cannot be read', async () => {
      window.runova.settings.get = vi.fn(async () => {
        throw new Error('settings unavailable');
      });
      await mount();
      await inboxChanged([notification()]);

      // A failed read must not cost the user the way into a failure they were told about.
      expect(toastFns.error.mock.calls[0][1].action.label).toBe('Open');
    });

    it('keeps the link while the setting has never been saved', async () => {
      await mount();
      await inboxChanged([notification()]);

      expect(toastFns.error.mock.calls[0][1].action.label).toBe('Open');
    });
  });

  it("shows a server alert by its severity and opens that server's page", async () => {
    await mount();
    await inboxChanged([
      notification({
        id: 'deploy-alert:srv-1:1:1',
        kind: 'deploy-warning',
        title: 'A disk is filling up on Production',
        body: '/ is 91% full.',
        projectId: null,
        projectName: 'Production',
        htmlUrl: null,
        route: '/deploy?server=srv-1',
      }),
      notification({ id: 'deploy-alert:srv-1:2:3', kind: 'deploy-critical', htmlUrl: null }),
      notification({ id: 'deploy-alert:srv-1:3:4', kind: 'deploy-info', htmlUrl: null }),
    ]);

    expect(toastFns.warning).toHaveBeenCalledTimes(1);
    expect(toastFns.error).toHaveBeenCalledTimes(1);
    expect(toastFns.info).toHaveBeenCalledTimes(1);
    const history = useToastHistoryStore.getState().items;
    expect(history.map((item) => item.tag)).toEqual(
      expect.arrayContaining(['Warning', 'Critical']),
    );
    await act(async () => toastFns.warning.mock.calls[0][1].action.onClick());
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe(
      '/deploy?server=srv-1',
    );
  });

  it('only follows a route inside the app', async () => {
    await mount();
    await inboxChanged([
      notification({
        kind: 'deploy-warning',
        htmlUrl: null,
        route: 'https://example.com/elsewhere',
      }),
    ]);

    await act(async () => toastFns.warning.mock.calls[0][1].action?.onClick?.());
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/');
    expect(window.runova.shell.openExternal).not.toHaveBeenCalled();
  });

  it('sends a non-pipeline link to the browser', async () => {
    await mount();
    await inboxChanged([
      notification({
        kind: 'tool-update-available',
        title: 'CLI update',
        projectId: null,
        htmlUrl: 'https://www.npmjs.com/package/x',
      }),
    ]);

    expect(toastFns.info).toHaveBeenCalledTimes(1);
    await act(async () => toastFns.info.mock.calls[0][1].action.onClick());
    expect(window.runova.shell.openExternal).toHaveBeenCalledWith(
      'https://www.npmjs.com/package/x',
    );
  });
});
