// @vitest-environment jsdom
import type { Project } from '@runova/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useExplorerStore } from '@/stores/explorerStore';
import { installRunovaBridge } from '../../../../../test/renderer/runovaBridge';
import { ExplorerSection } from './ExplorerSection';

/** The search box's place in the explorer: how it opens, and what it does to the tree. */

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;

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

function findKey(): void {
  fireEvent.keyDown(screen.getByRole('tree'), { key: 'f', code: 'KeyF', ctrlKey: true });
}

beforeEach(() => {
  useExplorerStore.setState({ projects: {} });
  installRunovaBridge({
    'fs.listDirectory': [
      { name: 'src', path: 'E:\\work\\app\\src', isDirectory: true },
      { name: 'README.md', path: 'E:\\work\\app\\README.md', isDirectory: false },
    ],
    'explorer.ignoredPaths': [],
    'explorer.listFiles': {
      root: 'E:\\work\\app',
      files: ['README.md', 'src/main.ts'],
      truncated: false,
    },
  });
});

afterEach(cleanup);

describe('ExplorerSection search', () => {
  it('has no search box until one is asked for', () => {
    renderSection();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('opens the box on the find key, with the tree still showing', async () => {
    renderSection();
    expect(await screen.findByText('README.md')).toBeInTheDocument();

    findKey();

    expect(screen.getByRole('combobox', { name: 'Search files by name' })).toBeInTheDocument();
    expect(screen.getByRole('tree').className).not.toContain('hidden');
  });

  it('puts the results where the tree was once something is typed', async () => {
    renderSection();
    findKey();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'main' } });

    expect(await screen.findByRole('option')).toHaveTextContent('main.ts');
    expect(screen.getByRole('tree').className).toContain('hidden');
  });

  it('gives the box back on the second find key, leaving the tree alone', async () => {
    renderSection();
    findKey();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'main' } });
    await screen.findByRole('option');

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('tree').className).not.toContain('hidden');
  });
});
