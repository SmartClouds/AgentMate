import type { Project } from '@runova/core';
import type { TextSearchRequest } from '@shared/apiTypes';
import { packSymbolIndex, type SymbolEntry } from '@shared/symbolIndex';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRecentFilesStore } from '@/stores/recentFilesStore';
import { useWorkspaceSearchStore } from '@/stores/workspaceSearchStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import type { FakeBridge } from '../../../../../test/renderer/runovaBridge';
import { WorkspaceSearchDialog } from './WorkspaceSearchDialog';

// The real setup loads Monaco's web workers, which only the app's bundler can resolve.
vi.mock('@/components/editor/monacoSetup', () => ({ resolveMonacoThemeKey: () => 'dark' }));

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;

const FILES = ['README.md', 'src/stores/workspaceStore.ts', 'src/index.ts', 'src/api/userApi.ts'];

function entry(partial: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'kind'>): SymbolEntry {
  return { container: '', path: 'src/index.ts', line: 1, column: 1, ...partial };
}

const SYMBOLS = packSymbolIndex(
  [
    entry({ name: 'User', kind: 'interface', path: 'src/api/userApi.ts', line: 12, column: 18 }),
    entry({ name: 'UserStore', kind: 'class', path: 'src/stores/workspaceStore.ts', line: 3 }),
    entry({ name: 'loadUser', kind: 'method', container: 'UserStore', line: 20, column: 3 }),
  ],
  { version: 1, root: 'E:\\work\\app', truncated: false, unavailable: false },
);

let bridge: FakeBridge;

function renderDialog() {
  const view = renderWithProviders(<WorkspaceSearchDialog project={project} />, {
    bridge: {
      'explorer.listFiles': { root: 'E:\\work\\app', files: FILES, truncated: false },
      'workspaceSearch.symbols': SYMBOLS,
      'workspaceSearch.text': () => new Promise(() => undefined),
      'fs.readFile': () => 'line one\nline two\n',
    },
  });
  bridge = view.bridge;
  return view;
}

function input(): HTMLInputElement {
  return screen.getByRole('combobox') as HTMLInputElement;
}

function type(text: string): void {
  fireEvent.change(input(), { target: { value: text } });
}

function press(key: string, init: Partial<KeyboardEventInit> = {}): void {
  fireEvent.keyDown(input(), {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ...init,
  });
}

function options(): string[] {
  return screen.queryAllByRole('option').map((option) => option.textContent ?? '');
}

function lastTextRequest(): { requestId: string; request: TextSearchRequest } {
  const calls = bridge.$fn('workspaceSearch.text').mock.calls;
  const [, requestId, request] = calls.at(-1) as [string, string, TextSearchRequest];
  return { requestId, request };
}

beforeEach(() => {
  useWorkspaceSearchStore.getState().openSearch(project.id);
});

describe('WorkspaceSearchDialog', () => {
  it('opens on the last query, ready to type over', async () => {
    useWorkspaceSearchStore.getState().setQuery(project.id, 'store');
    renderDialog();
    const box = input();
    expect(box).toHaveValue('store');
    await waitFor(() => expect(box).toHaveFocus());
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 5]);
  });

  it('finds files by name', async () => {
    renderDialog();
    type('workspacestore');
    await waitFor(() =>
      expect(options().some((text) => text.includes('workspaceStore.ts'))).toBe(true),
    );
  });

  it('filters to types with t:, and marks that tab', async () => {
    renderDialog();
    type('t:user');
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(options()[0]).toContain('User');
    expect(screen.getByRole('tab', { name: /types/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('rewrites the prefix when a tab is picked, keeping the text', async () => {
    renderDialog();
    type('t:user');
    fireEvent.click(screen.getByRole('tab', { name: /members/i }));
    expect(input()).toHaveValue('m:user');
    await waitFor(() => expect(options()[0]).toContain('loadUser'));
  });

  it('moves to the next filter with Tab', () => {
    renderDialog();
    type('user');
    press('Tab');
    expect(input()).toHaveValue('f:user');
    press('Tab', { shiftKey: true });
    expect(input()).toHaveValue('user');
  });

  it('searches text once typing settles and shows matches as they stream in', async () => {
    renderDialog();
    type('x:ne');
    type('x:needle');
    await waitFor(() => expect(bridge.$fn('workspaceSearch.text')).toHaveBeenCalledTimes(1));
    const { requestId, request } = lastTextRequest();
    expect(request).toMatchObject({ query: 'needle', matchCase: false, regex: false });

    act(() => {
      bridge.$emit('workspaceSearch.onTextResults', {
        requestId,
        files: [
          {
            path: 'src/index.ts',
            matches: [
              { line: 7, column: 3, text: 'a needle here', textOffset: 0, ranges: [[2, 8]] },
            ],
          },
        ],
      });
    });
    await waitFor(() =>
      expect(options().some((text) => text.includes('a needle here'))).toBe(true),
    );
  });

  it('drops results from a search that was replaced', async () => {
    renderDialog();
    type('x:needle');
    await waitFor(() => expect(bridge.$fn('workspaceSearch.text')).toHaveBeenCalled());
    act(() => {
      bridge.$emit('workspaceSearch.onTextResults', {
        requestId: 'someone-else',
        files: [
          {
            path: 'x.ts',
            matches: [{ line: 1, column: 1, text: 'stale', textOffset: 0, ranges: [] }],
          },
        ],
      });
    });
    expect(options().some((text) => text.includes('stale'))).toBe(false);
  });

  it('sends the text options with the search', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /match case/i }));
    type('x:needle');
    await waitFor(() => expect(bridge.$fn('workspaceSearch.text')).toHaveBeenCalled());
    expect(lastTextRequest().request.matchCase).toBe(true);
  });

  it('explains a pattern that does not parse', async () => {
    renderDialog();
    bridge.$set('workspaceSearch.text', async (_p: string, requestId: string) => ({
      requestId,
      matches: 0,
      files: 0,
      truncated: false,
      cancelled: false,
      error: 'Invalid regular expression: unclosed group',
      elapsedMs: 1,
    }));
    type('x:foo(');
    expect(await screen.findByText(/unclosed group/)).toBeInTheDocument();
  });

  it('walks the results with the arrow keys and previews where each one is', async () => {
    renderDialog();
    type('t:user');
    await waitFor(() => expect(options()).toHaveLength(2));
    const first = input().getAttribute('aria-activedescendant');
    press('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).not.toBe(first);
    press('ArrowUp');
    expect(input().getAttribute('aria-activedescendant')).toBe(first);
    const preview = screen.getByRole('region', { name: /preview/i });
    expect(within(preview).getByText('Ln 12, Ch 18')).toBeInTheDocument();
  });

  it('opens the result at its line with Enter, and closes', async () => {
    const openFile = vi.fn();
    useWorkspaceStore.setState({ openFile });
    renderDialog();
    type('t:user');
    await waitFor(() => expect(options()).toHaveLength(2));
    press('Enter');
    expect(openFile).toHaveBeenCalledWith('p1', 'E:\\work\\app\\src\\api\\userApi.ts', {
      pin: true,
      reveal: { line: 12, column: 18, length: 4 },
    });
    expect(useWorkspaceSearchStore.getState().open).toBe(false);
  });

  it('opens a file at the line typed after its name', async () => {
    const openFile = vi.fn();
    useWorkspaceStore.setState({ openFile });
    renderDialog();
    type('f:index.ts:42');
    await waitFor(() => expect(options()[0]).toContain('index.ts'));
    press('Enter');
    expect(openFile).toHaveBeenCalledWith('p1', 'E:\\work\\app\\src\\index.ts', {
      pin: true,
      reveal: { line: 42, column: 1 },
    });
  });

  it('opens beside the current pane with Ctrl+Enter', async () => {
    useWorkspaceStore.getState().openProject('p1');
    const focused = useWorkspaceStore.getState().workspaces.p1?.focusedGroupId;
    const openFile = vi.fn();
    const splitGroup = vi.fn(() => 'g2');
    useWorkspaceStore.setState({ openFile, splitGroup });
    renderDialog();
    type('f:readme');
    await waitFor(() => expect(options()[0]).toContain('README.md'));
    press('Enter', { ctrlKey: true });
    expect(splitGroup).toHaveBeenCalledWith('p1', focused, 'row');
    expect(openFile).toHaveBeenCalledWith('p1', 'E:\\work\\app\\README.md', { pin: true });
  });

  it('shows recent files before anything is typed', async () => {
    useRecentFilesStore.getState().touch('p1', 'E:\\work\\app\\README.md');
    useRecentFilesStore.getState().touch('p1', 'E:\\work\\app\\src\\index.ts');
    renderDialog();
    expect(await screen.findByText('Recent files')).toBeInTheDocument();
    expect(options().map((text) => text.slice(0, 8))).toEqual(['index.ts', 'README.m']);
  });

  it('shimmers in place while the symbols load, instead of covering the dialog', async () => {
    renderWithProviders(<WorkspaceSearchDialog project={project} />, {
      bridge: {
        'explorer.listFiles': { root: 'E:\\work\\app', files: FILES, truncated: false },
        'workspaceSearch.symbols': () => new Promise(() => undefined),
      },
    });
    type('t:user');
    expect(await screen.findByRole('listbox')).toHaveAttribute('aria-busy', 'true');
  });

  it('closes with Escape', async () => {
    renderDialog();
    fireEvent.keyDown(input(), { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(useWorkspaceSearchStore.getState().open).toBe(false));
  });
});
