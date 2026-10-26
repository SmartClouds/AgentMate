// @vitest-environment jsdom
import type { GitChangeEntry, Project } from '@runova/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useExplorerStore } from '@/stores/explorerStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { type FakeBridge, installRunovaBridge } from '../../../../../test/renderer/runovaBridge';
import { GitFileRow } from './GitFileRow';

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;

let bridge: FakeBridge;

function renderRow(
  entry: GitChangeEntry,
  handlers: { onOpen?: (pin: boolean) => void; onOpenFile?: () => void } = {},
) {
  return render(
    <TooltipProvider>
      <GitFileRow
        project={project}
        projectPrefix=""
        entry={entry}
        side="unstaged"
        selected={false}
        focusable
        onFocusRow={vi.fn()}
        onOpen={handlers.onOpen ?? vi.fn()}
        onOpenFile={handlers.onOpenFile ?? vi.fn()}
        onStage={vi.fn()}
        onDiscard={vi.fn()}
      />
    </TooltipProvider>,
  );
}

function openMenu(): void {
  fireEvent.contextMenu(screen.getByRole('option'));
}

beforeEach(() => {
  bridge = installRunovaBridge({ platform: 'win32' });
  useExplorerStore.setState({ projects: {} });
  useWorkspaceStore.getState().setGitPanel({ activeSection: 'sourceControl' });
});

afterEach(cleanup);

describe('GitFileRow menu', () => {
  const entry = { path: 'src/app/page.tsx', status: 'M' } as GitChangeEntry;

  it('opens the file itself, not its diff', () => {
    const onOpen = vi.fn();
    const onOpenFile = vi.fn();
    renderRow(entry, { onOpen, onOpenFile });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open File' }));
    expect(onOpenFile).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('reveals the file on disk and in the default app', () => {
    renderRow(entry);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in File Explorer' }));
    expect(bridge.$fn('explorer.revealInOs')).toHaveBeenCalledWith(
      'p1',
      'E:\\work\\app\\src\\app\\page.tsx',
    );

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open With Default App' }));
    expect(bridge.$fn('shell.openPath')).toHaveBeenCalledWith('E:\\work\\app\\src\\app\\page.tsx');
  });

  it('switches to the explorer and selects the file there', () => {
    renderRow(entry);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Explorer View' }));
    expect(useWorkspaceStore.getState().gitPanel.activeSection).toBe('explorer');
    const tree = useExplorerStore.getState().projects.p1;
    expect(tree?.selected).toEqual(['E:\\work\\app\\src\\app\\page.tsx']);
    expect(tree?.open['E:\\work\\app\\src\\app']).toBe(true);
    expect(tree?.open['E:\\work\\app\\src']).toBe(true);
  });

  it('keeps a deleted file out of the actions that need it on disk', () => {
    renderRow({ ...entry, status: 'D' } as GitChangeEntry);
    openMenu();
    for (const name of [
      'Open File',
      'Open With Default App',
      'Reveal in File Explorer',
      'Reveal in Explorer View',
    ]) {
      expect(screen.getByRole('menuitem', { name })).toHaveAttribute('data-disabled');
    }
    expect(screen.getByRole('menuitem', { name: 'Copy Path' })).not.toHaveAttribute(
      'data-disabled',
    );
  });
});

describe('GitFileRow conflict with AI', () => {
  const entry = { path: 'src/app.ts', status: 'U', conflict: 'UU' } as GitChangeEntry;

  function renderConflict(aiResolving: boolean) {
    const handlers = {
      onResolve: vi.fn(),
      onResolveWithAi: vi.fn(),
      onOpen: vi.fn(),
      onStage: vi.fn(),
    };
    render(
      <TooltipProvider>
        <GitFileRow
          project={project}
          projectPrefix=""
          entry={entry}
          side="conflict"
          selected={false}
          focusable
          onFocusRow={vi.fn()}
          onOpen={handlers.onOpen}
          onOpenFile={vi.fn()}
          onStage={aiResolving ? undefined : handlers.onStage}
          onResolve={handlers.onResolve}
          onResolveWithAi={handlers.onResolveWithAi}
          aiResolving={aiResolving}
        />
      </TooltipProvider>,
    );
    return handlers;
  }

  it('offers AI next to ours and theirs, without opening the diff', () => {
    const handlers = renderConflict(false);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve with AI' }));
    expect(handlers.onResolveWithAi).toHaveBeenCalledOnce();
    expect(handlers.onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Ours' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Theirs' })).toBeInTheDocument();
  });

  it('offers it from the right-click menu too', () => {
    const handlers = renderConflict(false);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resolve with AI' }));
    expect(handlers.onResolveWithAi).toHaveBeenCalledOnce();
  });

  it('while the AI works, shows a stop button and hides the actions that would race it', () => {
    const handlers = renderConflict(true);
    expect(screen.getByRole('option')).toHaveAccessibleName(/resolving with AI/);
    expect(screen.getByRole('option')).toHaveClass('shimmer');
    expect(screen.queryByRole('button', { name: 'Resolve with AI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ours' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Theirs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as resolved' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stop resolving with AI' }));
    expect(handlers.onResolveWithAi).toHaveBeenCalledOnce();
  });

  it('turns the menu item into a stop while the AI works', () => {
    const handlers = renderConflict(true);
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Mark as Resolved' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop Resolving with AI' }));
    expect(handlers.onResolveWithAi).toHaveBeenCalledOnce();
  });

  it('leaves AI off rows that are not in conflict', () => {
    renderRow({ path: 'src/app.ts', status: 'M' } as GitChangeEntry);
    expect(screen.queryByRole('button', { name: 'Resolve with AI' })).not.toBeInTheDocument();
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Resolve with AI' })).not.toBeInTheDocument();
  });
});
