// @vitest-environment jsdom
import type { Project } from '@runova/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useExplorerStore } from '@/stores/explorerStore';
import { installRunovaBridge } from '../../../../../test/renderer/runovaBridge';
import { ExplorerSection } from './ExplorerSection';

/**
 * Dragging real files in from Explorer, Finder or a Linux file manager, dropped straight onto
 * the workspace tree. `transferExternalEntries` is stubbed here (it has its own tests in
 * explorer/actions.paste.test.ts); this only covers resolving the drop to real paths and wiring
 * it into the right folder.
 */

const transferExternalEntries = vi.fn();

vi.mock('./explorer/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./explorer/actions')>()),
  transferExternalEntries: (...args: unknown[]) => transferExternalEntries(...args),
}));

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;
const SRC = 'E:\\work\\app\\src';
const README = 'E:\\work\\app\\README.md';

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

function osFile(name: string): File {
  return new File(['x'], name);
}

/** What a real drag from the OS file manager carries: no `files` until the drop itself. */
function osDragOver() {
  return { files: [], types: ['Files'] };
}

function osDrop(files: File[]) {
  return { files, types: ['Files'] };
}

/** What an in-app row drag carries, the way `onDragStart` fills it in. */
function inAppTransfer() {
  return { effectAllowed: '', setData: () => undefined };
}

async function row(name: string): Promise<Element> {
  return (await screen.findByText(name)).closest('[data-explorer-row]') as Element;
}

beforeEach(() => {
  transferExternalEntries.mockClear();
  useExplorerStore.setState({ projects: {} });
  installRunovaBridge({
    'fs.listDirectory': [
      { name: 'src', path: SRC, isDirectory: true },
      { name: 'README.md', path: README, isDirectory: false },
    ],
    'explorer.ignoredPaths': [],
    'shell.pathForFile': (file: File) =>
      file.name === 'unreadable.png' ? '' : `C:\\dropped\\${file.name}`,
  });
});

afterEach(cleanup);

describe('ExplorerSection OS drag-and-drop', () => {
  it('highlights the folder row while an OS file is dragged over it', async () => {
    renderSection();
    const target = await row('src');

    fireEvent.dragOver(target, { dataTransfer: osDragOver() });

    expect(target).toHaveClass('bg-primary/20');
  });

  it('resolves dropped OS files to their real paths and copies them into the folder they were dropped on', async () => {
    renderSection();
    const target = await row('src');

    fireEvent.drop(target, { dataTransfer: osDrop([osFile('a.png'), osFile('b.png')]) });

    expect(transferExternalEntries).toHaveBeenCalledWith(
      project,
      ['C:\\dropped\\a.png', 'C:\\dropped\\b.png'],
      SRC,
    );
  });

  it('copies onto the project root when files are dropped on the empty tree background', async () => {
    renderSection();
    await screen.findByText('src');
    const tree = screen.getByRole('tree');

    fireEvent.drop(tree, { dataTransfer: osDrop([osFile('a.png')]) });

    expect(transferExternalEntries).toHaveBeenCalledWith(
      project,
      ['C:\\dropped\\a.png'],
      project.folderPath,
    );
  });

  it('ignores a file that has no path on disk', async () => {
    renderSection();
    const target = await row('src');

    fireEvent.drop(target, { dataTransfer: osDrop([osFile('unreadable.png')]) });

    expect(transferExternalEntries).not.toHaveBeenCalled();
  });

  it('prevents the browser from taking over an external drop', async () => {
    renderSection();
    const target = await row('src');

    const notCancelled = fireEvent.drop(target, { dataTransfer: osDrop([osFile('a.png')]) });

    expect(notCancelled).toBe(false);
  });

  it('still moves or copies normally for an in-app drag', async () => {
    installRunovaBridge({
      'fs.listDirectory': [
        { name: 'src', path: SRC, isDirectory: true },
        { name: 'README.md', path: README, isDirectory: false },
      ],
      'explorer.ignoredPaths': [],
      'explorer.move': { moves: [{ from: README, to: `${SRC}\\README.md` }], conflicts: [] },
    });
    renderSection();
    const source = await row('README.md');
    const target = await row('src');

    fireEvent.dragStart(source, { dataTransfer: inAppTransfer() });
    fireEvent.drop(target, { dataTransfer: inAppTransfer() });

    expect(transferExternalEntries).not.toHaveBeenCalled();
  });
});
