// @vitest-environment jsdom
import type { Project } from '@agentmat/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toggleExplorerSearch, useExplorerStore } from '@/stores/explorerStore';
import { useWorkspaceSearchStore } from '@/stores/workspaceSearchStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { installAgentmatBridge } from '../../../../../../test/renderer/agentmatBridge';
import { ExplorerSearch } from './ExplorerSearch';

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;

const FILES = [
  'README.md',
  'src/stores/workspaceStore.ts',
  'src/components/workspace/GitPanel.tsx',
  'src/main/ipc/explorer.ts',
];

const onClose = vi.fn();

/** Stands in for the tree section, which owns what is typed in the box. */
function Harness(): React.JSX.Element {
  const query = useExplorerStore((s) => s.projects[project.id]?.search ?? '');
  return (
    <ExplorerSearch
      project={project}
      query={query}
      statusByPath={new Map([['src/stores/workspaceStore.ts', 'M']])}
      projectPrefix=""
      activePath={null}
      onClose={onClose}
    />
  );
}

function renderSearch() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Harness />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function type(text: string): void {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: text } });
}

beforeEach(() => {
  onClose.mockClear();
  useExplorerStore.setState({ projects: {} });
  toggleExplorerSearch(project.id, true);
  installAgentmatBridge({
    'explorer.listFiles': { root: 'E:\\work\\app', files: FILES, truncated: false },
  });
});

afterEach(cleanup);

describe('handing over to the full search', () => {
  it('opens the search dialog with what was typed', async () => {
    renderSearch();
    type('panel');
    fireEvent.click(screen.getByRole('button', { name: /search files and code/i }));
    expect(useWorkspaceSearchStore.getState()).toMatchObject({
      open: true,
      projectId: 'p1',
      queries: { p1: 'panel' },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('offers to look for the text inside files', async () => {
    renderSearch();
    type('needle');
    fireEvent.click(await screen.findByRole('button', { name: /search in file contents/i }));
    expect(useWorkspaceSearchStore.getState().queries.p1).toBe('x:needle');
  });
});

describe('ExplorerSearch', () => {
  it('shows nothing until something is typed', async () => {
    renderSearch();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    type('panel');

    expect(await screen.findByRole('option')).toHaveTextContent('GitPanel.tsx');
  });

  it('opens the file a result stands for, and its folder beside the name', async () => {
    const openFile = vi.fn();
    useWorkspaceStore.setState({ openFile });
    renderSearch();

    type('workspacestore');
    fireEvent.click(await screen.findByRole('option'));

    expect(openFile).toHaveBeenCalledWith('p1', 'E:\\work\\app\\src\\stores\\workspaceStore.ts', {
      pin: false,
    });
    expect(screen.getByRole('option')).toHaveTextContent('src/stores');
    // The file is changed, so the row carries the same letter the tree would show.
    expect(screen.getByRole('option')).toHaveTextContent('M');
  });

  it('opens the highlighted result on Enter, and moves with the arrow keys', async () => {
    const openFile = vi.fn();
    useWorkspaceStore.setState({ openFile });
    renderSearch();

    type('s');
    await screen.findAllByRole('option');
    const box = screen.getByRole('combobox');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });

    const second = screen.getAllByRole('option')[1];
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(openFile).toHaveBeenCalledWith('p1', expect.any(String), { pin: true });
  });

  it('keeps the end of a deep folder path, where the telling part is', async () => {
    const deep = 'apps/desktop/src/renderer/src/components/workspace/git/explorer/keys.ts';
    installAgentmatBridge({
      'explorer.listFiles': { root: 'E:\\work\\app', files: [deep], truncated: false },
    });
    renderSearch();

    type('keys.ts');

    const option = await screen.findByRole('option');
    expect(option).toHaveTextContent('…/src/components/workspace/git/explorer');
    expect(option).not.toHaveTextContent('apps/desktop');
  });

  it('says so when nothing matches', async () => {
    renderSearch();

    type('zzzz');

    expect(await screen.findByText(/No file matches/)).toBeInTheDocument();
  });

  it('lists the files that fit a wildcard pattern', async () => {
    renderSearch();

    type('*.ts');

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    const names = screen.getAllByRole('option').map((option) => option.textContent);
    expect(names.join(' ')).toContain('workspaceStore.ts');
    expect(names.join(' ')).toContain('explorer.ts');
    expect(names.join(' ')).not.toContain('GitPanel.tsx');
    expect(names.join(' ')).not.toContain('README.md');
  });

  it('takes a regular expression between two slashes', async () => {
    renderSearch();

    type('/^readme\\.md$/');

    expect(await screen.findByRole('option')).toHaveTextContent('README.md');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('says so when the regular expression is not valid', async () => {
    renderSearch();

    type('/(/');

    expect(await screen.findByText(/not a valid regular expression/i)).toBeInTheDocument();
    expect(screen.queryByText(/No file matches/)).not.toBeInTheDocument();
  });

  it('tells the user that patterns work, in the placeholder', () => {
    renderSearch();

    expect(screen.getByPlaceholderText(/\*\.md/)).toBeInTheDocument();
  });

  it('clears on the first Escape and closes on the second', async () => {
    renderSearch();

    type('panel');
    await screen.findByRole('option');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the folders down to a result when asked to show it in the tree', async () => {
    renderSearch();

    type('workspacestore');
    fireEvent.click(await screen.findByRole('button', { name: /Show workspaceStore.ts in tree/ }));

    expect(onClose).toHaveBeenCalled();
    const state = useExplorerStore.getState().projects[project.id];
    expect(state?.open).toEqual({
      'E:\\work\\app\\src': true,
      'E:\\work\\app\\src\\stores': true,
    });
    expect(state?.selected).toEqual(['E:\\work\\app\\src\\stores\\workspaceStore.ts']);
  });
});
