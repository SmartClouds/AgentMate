// @vitest-environment jsdom
import type { Project } from '@runova/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useCliStore } from '@/stores/cliStore';
import { selectRows, useExplorerStore } from '@/stores/explorerStore';
import { installRunovaBridge } from '../../../../../test/renderer/runovaBridge';
import { ExplorerSection } from './ExplorerSection';

/** "Add to agent chat" in the explorer: the menu item and its key, for one row or several. */

const sendPathsToAgent = vi.fn();
const findAgentTerminal = vi.fn();

vi.mock('./explorer/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./explorer/actions')>()),
  sendPathsToAgent: (...args: unknown[]) => sendPathsToAgent(...args),
}));
vi.mock('@/lib/workspace/agentTarget', () => ({
  findAgentTerminal: () => findAgentTerminal(),
  rememberAgentTab: vi.fn(),
}));

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;
const README = 'E:\\work\\app\\README.md';
const SRC = 'E:\\work\\app\\src';

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ExplorerSection project={project} state={undefined} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sendPathsToAgent.mockClear();
  findAgentTerminal.mockReturnValue({ kind: 'terminal', id: 't1', cliId: 'claude-code' });
  useCliStore.setState({ defaultCliId: 'claude-code' });
  useExplorerStore.setState({ projects: {} });
  installRunovaBridge({
    'fs.listDirectory': [
      { name: 'src', path: SRC, isDirectory: true },
      { name: 'README.md', path: README, isDirectory: false },
    ],
    'explorer.ignoredPaths': [],
  });
});

afterEach(cleanup);

describe('ExplorerSection add to agent chat', () => {
  it('offers the running agent for a right-clicked row and hands it the row', async () => {
    renderSection();
    fireEvent.contextMenu(await screen.findByText('README.md'));

    fireEvent.click(await screen.findByRole('menuitem', { name: /Add to Claude Code/ }));

    await vi.waitFor(() => expect(sendPathsToAgent).toHaveBeenCalled());
    expect(sendPathsToAgent.mock.calls[0]?.[1]).toEqual([README]);
  });

  it('hands over the whole selection when a selected row is right-clicked', async () => {
    renderSection();
    await screen.findByText('README.md');
    selectRows(project.id, [SRC, README], { focused: README, anchor: SRC });
    fireEvent.contextMenu(screen.getByText('README.md'));

    fireEvent.click(await screen.findByRole('menuitem', { name: /Add to Claude Code/ }));

    await vi.waitFor(() => expect(sendPathsToAgent).toHaveBeenCalled());
    expect(sendPathsToAgent.mock.calls[0]?.[1]).toEqual([SRC, README]);
  });

  it('names the new tab it would open when no agent is running', async () => {
    findAgentTerminal.mockReturnValue(null);
    renderSection();
    fireEvent.contextMenu(await screen.findByText('README.md'));

    expect(
      await screen.findByRole('menuitem', { name: /Add to New Claude Code Tab/ }),
    ).toBeInTheDocument();
  });

  it('has no such item for the project root', async () => {
    renderSection();
    await screen.findByText('README.md');
    fireEvent.contextMenu(screen.getByRole('tree'));

    expect(await screen.findByRole('menuitem', { name: /Collapse Folders/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Add to/ })).not.toBeInTheDocument();
  });

  it('sends the selection on the key', async () => {
    renderSection();
    await screen.findByText('README.md');
    selectRows(project.id, [SRC, README], { focused: README, anchor: SRC });

    fireEvent.keyDown(screen.getByRole('tree'), { key: 'l', code: 'KeyL', ctrlKey: true });

    expect(sendPathsToAgent).toHaveBeenCalledWith(project, [SRC, README]);
  });
});
