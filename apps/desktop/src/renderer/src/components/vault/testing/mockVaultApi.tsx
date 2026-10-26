import type { VaultEntrySummary } from '@runova/core';
import type { VaultStateEvent, VaultStatus } from '@shared/apiTypes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { type InitialEntry, MemoryRouter } from 'react-router-dom';
import { expect, type Mock, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

type Listener<T> = (payload: T) => void;
type Fn = Mock<(...args: never[]) => unknown>;

type InvokeName =
  | 'status'
  | 'create'
  | 'unlock'
  | 'lock'
  | 'changePassword'
  | 'reset'
  | 'list'
  | 'getForEdit'
  | 'reveal'
  | 'copy'
  | 'save'
  | 'remove'
  | 'patch'
  | 'duplicate'
  | 'touch'
  | 'importOpen'
  | 'importPreview'
  | 'importCommit'
  | 'importCancel'
  | 'exportCsv'
  | 'fetchIcon';

export interface VaultApiMock {
  api: Record<InvokeName, Fn> & {
    onStateChanged: (cb: Listener<VaultStateEvent>) => () => void;
    onEntriesChanged: (cb: Listener<void>) => () => void;
    onClipboardSettled: (cb: Listener<{ cleared: boolean }>) => () => void;
  };
  status: VaultStatus;
  emitState(event: VaultStateEvent): void;
  emitEntriesChanged(): void;
  emitClipboard(cleared: boolean): void;
}

/** A fake `window.runova.vault` whose calls are spies, plus a way to fire main-process events. */
export function createVaultApiMock(initial: Partial<VaultStatus> = {}): VaultApiMock {
  const stateListeners = new Set<Listener<VaultStateEvent>>();
  const entriesListeners = new Set<Listener<void>>();
  const clipboardListeners = new Set<Listener<{ cleared: boolean }>>();
  const status: VaultStatus = {
    state: 'unlocked',
    retryAfterMs: 0,
    autoLockMinutes: 15,
    clipboardClearSeconds: 30,
    ...initial,
  };

  const api = {
    status: vi.fn(async () => ({ ...status })),
    create: vi.fn(async (_password: string) => undefined),
    unlock: vi.fn(async (_password: string) => ({ ok: true }) as const),
    lock: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => true),
    reset: vi.fn(async () => undefined),
    list: vi.fn(async (): Promise<VaultEntrySummary[]> => []),
    getForEdit: vi.fn(),
    reveal: vi.fn(async () => ''),
    copy: vi.fn(async () => ({ clearsAt: Date.now() + 30_000 })),
    save: vi.fn(),
    remove: vi.fn(async (ids: string[]) => ids.length),
    patch: vi.fn(),
    duplicate: vi.fn(),
    touch: vi.fn(async () => undefined),
    fetchIcon: vi.fn(async (_siteUrl: string): Promise<string | null> => null),
    importOpen: vi.fn(async () => null),
    importPreview: vi.fn(),
    importCommit: vi.fn(),
    importCancel: vi.fn(async () => undefined),
    exportCsv: vi.fn(async () => ({ ok: true }) as const),
    onStateChanged: (cb: Listener<VaultStateEvent>) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    onEntriesChanged: (cb: Listener<void>) => {
      entriesListeners.add(cb);
      return () => entriesListeners.delete(cb);
    },
    onClipboardSettled: (cb: Listener<{ cleared: boolean }>) => {
      clipboardListeners.add(cb);
      return () => clipboardListeners.delete(cb);
    },
  };

  return {
    api: api as unknown as VaultApiMock['api'],
    status,
    emitState(event: VaultStateEvent) {
      status.state = event.state;
      for (const listener of stateListeners) listener(event);
    },
    emitEntriesChanged() {
      for (const listener of entriesListeners) listener();
    },
    emitClipboard(cleared: boolean) {
      for (const listener of clipboardListeners) listener({ cleared });
    },
  };
}

export function installVaultApi(mock: VaultApiMock): void {
  Object.assign(window, {
    runova: {
      platform: 'win32',
      vault: mock.api,
      shell: { openExternal: vi.fn(async () => undefined) },
    },
  });
}

let counter = 0;
export function summary(overrides: Partial<VaultEntrySummary> = {}): VaultEntrySummary {
  counter++;
  return {
    id: `entry-${counter}`,
    type: 'login',
    title: `Entry ${counter}`,
    tags: [],
    favorite: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastUsedAt: null,
    username: '',
    service: '',
    keyId: '',
    urls: [],
    host: '',
    hasPassword: true,
    hasTotp: false,
    hasSecret: false,
    hasNotes: false,
    passwordUpdatedAt: null,
    expiresAt: null,
    fields: [],
    ...overrides,
  };
}

export function renderWithVaultProviders(
  ui: ReactNode,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  initialEntries: InitialEntry[] = ['/vault'],
): RenderResult & { client: QueryClient } {
  const result = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

/** The app never uses native `title` tooltips; every hint goes through SimpleTooltip. */
export function expectNoNativeTitles(): void {
  expect(document.querySelectorAll('[title]')).toHaveLength(0);
}

const noop = (): void => undefined;

/** jsdom lacks a few browser APIs Radix reaches for. */
export function installDomShims(): void {
  if (!('ResizeObserver' in window)) {
    Object.assign(window, {
      ResizeObserver: class {
        observe = noop;
        unobserve = noop;
        disconnect = noop;
      },
    });
  }
  if (!window.matchMedia) {
    Object.assign(window, {
      matchMedia: () => ({
        matches: false,
        addEventListener: noop,
        removeEventListener: noop,
        addListener: noop,
        removeListener: noop,
      }),
    });
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => undefined;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
}
