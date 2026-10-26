// @vitest-environment jsdom

import type { Project } from '@runova/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomShims } from '@/components/vault/testing/mockVaultApi';
import { useToastHistoryStore } from '@/stores/toastHistoryStore';
import { ToastHistoryPanel } from './ToastHistoryPanel';

installDomShims();

const PROJECT = {
  id: 'p1',
  name: 'Demo',
  iconDataUrl: 'data:image/png;base64,AAAA',
  iconBgColor: null,
  iconColor: null,
} as unknown as Project;

function Probe(): React.JSX.Element {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{`${pathname}${search}`}</span>;
}

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ToastHistoryPanel />
        <Probe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Object.assign(window, {
    runova: {
      projects: { list: vi.fn(async () => [PROJECT]) },
      shell: { openExternal: vi.fn(async () => undefined) },
      appNotifications: { markRead: vi.fn(async () => []) },
    },
  });
  useToastHistoryStore.setState({
    open: true,
    items: [
      {
        id: 'a',
        kind: 'error',
        title: 'CI failed',
        description: 'Demo · main · run #42',
        createdAt: new Date().toISOString(),
        read: true,
        count: 1,
        projectId: 'p1',
        projectName: 'Demo',
        tag: 'Failed',
        link: { route: '/pipelines?run=1&repo=acme%2Fdemo', notificationId: 'n1' },
      },
      {
        id: 'b',
        kind: 'info',
        title: 'Saved',
        description: '',
        createdAt: new Date().toISOString(),
        read: true,
        count: 1,
      },
    ],
  });
});

afterEach(cleanup);

describe('ToastHistoryPanel links', () => {
  it('shows the project icon and outcome tag on a linked row', async () => {
    mount();
    await screen.findByText('Failed');
    await waitFor(() =>
      expect(document.querySelector('img[src="data:image/png;base64,AAAA"]')).not.toBeNull(),
    );
  });

  it('opens the linked page in the app, marks it read and closes the panel', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open: CI failed' }));

    expect(screen.getByTestId('location').textContent).toBe('/pipelines?run=1&repo=acme%2Fdemo');
    expect(window.runova.appNotifications.markRead).toHaveBeenCalledWith('n1');
    expect(useToastHistoryStore.getState().open).toBe(false);
  });

  it('does not treat a plain message as openable', async () => {
    mount();
    await screen.findByText('Saved');
    expect(screen.queryByRole('button', { name: 'Open: Saved' })).toBeNull();
  });

  it('keeps Remove from also opening the row', async () => {
    mount();
    const buttons = await screen.findAllByRole('button', { name: 'Remove from history' });
    fireEvent.click(buttons[0]);

    expect(screen.getByTestId('location').textContent).toBe('/');
    expect(useToastHistoryStore.getState().items).toHaveLength(1);
  });
});
