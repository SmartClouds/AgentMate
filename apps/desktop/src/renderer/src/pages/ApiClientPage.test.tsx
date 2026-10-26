import { POSTMAN_SCHEMA_V21, type PostmanCollection } from '@runova/core';
import type { ApiCollectionSummary, ApiExecutionResult } from '@shared/apiClientTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { useApiClientTabsStore } from '@/stores/apiClientTabsStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea
      data-testid="monaco-editor"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

const { default: ApiClientPage } = await import('./ApiClientPage');

const summary: ApiCollectionSummary = {
  id: 'c1',
  name: 'Users API',
  requestCount: 1,
  projectIds: [],
  updatedAt: 0,
  error: null,
  tree: [{ id: 'r1', name: 'List users', kind: 'request', method: 'GET' }],
};

const collection: PostmanCollection = {
  info: { name: 'Users API', schema: POSTMAN_SCHEMA_V21 },
  item: [
    {
      id: 'r1',
      name: 'List users',
      request: { method: 'GET', url: 'https://api.test/users?page=1' },
    },
  ],
};

const okResult = (requestId: string): ApiExecutionResult => ({
  requestId,
  ok: true,
  cancelled: false,
  error: null,
  response: {
    status: 200,
    statusText: 'OK',
    headers: [{ key: 'content-type', value: 'application/json' }],
    body: '{"users":[]}',
    bodyEncoding: 'utf8',
    bodyTruncated: false,
    mime: 'application/json',
    size: { body: 12, headers: 40 },
    timings: { dns: 0, tcp: 0, tls: 0, firstByte: 10, download: 2, total: 12 },
    httpVersion: '1.1',
  },
  sent: null,
  tests: [],
  console: [],
  scriptErrors: [],
  startedAt: 0,
});

function renderPage(overrides: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <ApiClientPage />
      <ConfirmDialogHost />
    </>,
    {
      route: '/api-client',
      bridge: {
        'apiClient.listCollections': [summary],
        'apiClient.getCollection': collection,
        'apiClient.execute': async (input: { requestId: string }) => okResult(input.requestId),
        'apiClient.saveRequest': summary,
        ...overrides,
      },
    },
  );
}

beforeEach(() => {
  useApiClientTabsStore.setState({ tabs: [], activeTabId: null });
});

describe('ApiClientPage', () => {
  it('lists collections and offers to start a request', async () => {
    renderPage();
    expect(await screen.findByRole('treeitem', { name: 'Users API' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New request' })).toBeInTheDocument();
  });

  it('sends a new request and shows the response', async () => {
    const { user, bridge } = renderPage();
    await user.click(await screen.findByRole('button', { name: 'New request' }));

    await user.type(
      screen.getByRole('textbox', { name: 'Request URL' }),
      'https://api.test/ping?x=1',
    );
    expect(screen.getByRole('tab', { name: /params/i })).toHaveTextContent('1');
    await user.click(screen.getByRole('button', { name: /^send/i }));

    expect(await screen.findByText('200 OK')).toBeInTheDocument();
    expect(bridge.$fn('apiClient.execute')).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        request: expect.objectContaining({
          method: 'GET',
          url: expect.objectContaining({ raw: 'https://api.test/ping?x=1' }),
        }),
        collectionId: null,
        itemId: null,
      }),
    );
  });

  it('sends with Ctrl+Enter', async () => {
    const { user, bridge } = renderPage();
    await user.click(await screen.findByRole('button', { name: 'New request' }));
    await user.type(screen.getByRole('textbox', { name: 'Request URL' }), 'https://a.test');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(bridge.$fn('apiClient.execute')).toHaveBeenCalledTimes(1));
  });

  it('opens a saved request from the sidebar and saves changes back in place', async () => {
    const { user, bridge } = renderPage();
    await user.click(await screen.findByRole('treeitem', { name: 'Users API' }));
    await user.click(screen.getByRole('treeitem', { name: 'GET List users' }));

    const url = await screen.findByRole('textbox', { name: 'Request URL' });
    expect(url).toHaveValue('https://api.test/users?page=1');
    expect(bridge.$fn('apiClient.getCollection')).toHaveBeenCalledWith('c1');

    await user.clear(url);
    await user.type(url, 'https://api.test/users?page=2');
    expect(screen.getByRole('tab', { name: /List users.*unsaved/i })).toBeInTheDocument();

    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() =>
      expect(bridge.$fn('apiClient.saveRequest')).toHaveBeenCalledWith({
        collectionId: 'c1',
        parentId: null,
        item: expect.objectContaining({
          id: 'r1',
          name: 'List users',
          request: expect.objectContaining({
            url: expect.objectContaining({ raw: 'https://api.test/users?page=2' }),
          }),
        }),
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: /unsaved/i })).not.toBeInTheDocument(),
    );
  });

  it('asks where to save a new request', async () => {
    const { user, bridge } = renderPage();
    await user.click(await screen.findByRole('button', { name: 'New request' }));
    await user.type(screen.getByRole('textbox', { name: 'Request URL' }), 'https://a.test/health');
    await user.click(screen.getByRole('button', { name: /^save/i }));

    const dialog = await screen.findByRole('dialog', { name: 'Save request' });
    const name = within(dialog).getByRole('textbox', { name: 'Request name' });
    expect(name).toHaveValue('https://a.test/health');
    await user.clear(name);
    await user.type(name, 'Health');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(bridge.$fn('apiClient.saveRequest')).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionId: 'c1',
          parentId: null,
          item: expect.objectContaining({ name: 'Health' }),
        }),
      ),
    );
    expect(await screen.findByRole('tab', { name: 'GET Health' })).toBeInTheDocument();
  });

  it('asks before closing a tab with unsaved changes', async () => {
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: 'New request' }));
    await user.type(screen.getByRole('textbox', { name: 'Request URL' }), 'https://a.test');
    await user.click(screen.getByRole('button', { name: /close untitled request/i }));

    const confirm = await screen.findByRole('dialog', { name: /discard/i });
    await user.click(within(confirm).getByRole('button', { name: /cancel/i }));
    expect(screen.getByRole('tab', { name: /untitled request/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /close untitled request/i }));
    await user.click(
      within(await screen.findByRole('dialog', { name: /discard/i })).getByRole('button', {
        name: /discard/i,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: /untitled request/i })).not.toBeInTheDocument(),
    );
  });

  it('creates a collection', async () => {
    const { user, bridge } = renderPage({
      'apiClient.listCollections': [],
      'apiClient.createCollection': { ...summary, id: 'c2', name: 'Orders', tree: [] },
    });
    await user.click(await screen.findByRole('button', { name: /create a collection/i }));
    const dialog = await screen.findByRole('dialog', { name: /new collection/i });
    await user.type(within(dialog).getByRole('textbox', { name: 'Collection name' }), 'Orders');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(bridge.$fn('apiClient.createCollection')).toHaveBeenCalledWith('Orders'),
    );
  });
});
