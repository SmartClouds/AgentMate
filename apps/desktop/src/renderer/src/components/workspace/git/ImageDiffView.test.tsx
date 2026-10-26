// @vitest-environment jsdom
import type { Project } from '@runova/core';
import type { GitImageDiff } from '@shared/apiTypes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { WorkspaceDiffTab } from '@/stores/workspaceStore';
import { installRunovaBridge } from '../../../../../test/renderer/runovaBridge';
import { ImageDiffView } from './ImageDiffView';

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;

const tab: WorkspaceDiffTab = {
  kind: 'diff',
  id: 'd1',
  path: 'assets/logo.png',
  side: 'unstaged',
  preview: false,
};

function renderDiff(answer: GitImageDiff | (() => Promise<never>), view = tab) {
  const bridge = installRunovaBridge({ 'git.fileImage': answer, 'git.commitFileImage': answer });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ImageDiffView project={project} tab={view} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return bridge;
}

afterEach(cleanup);

describe('ImageDiffView', () => {
  it('puts both versions of a changed picture side by side', async () => {
    renderDiff({
      path: tab.path,
      original: { dataUrl: 'data:image/png;base64,OLD', bytes: 1024 },
      modified: { dataUrl: 'data:image/png;base64,NEW', bytes: 4096 },
      tooLarge: false,
    });

    expect(await screen.findByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
    expect(screen.getByAltText('logo.png before the change')).toHaveAttribute(
      'src',
      'data:image/png;base64,OLD',
    );
    expect(screen.getByAltText('logo.png after the change')).toHaveAttribute(
      'src',
      'data:image/png;base64,NEW',
    );
    // The sizes are the part of a binary change anyone can read.
    expect(screen.getByText('1.00 KB')).toBeInTheDocument();
    expect(screen.getByText('4.00 KB')).toBeInTheDocument();
  });

  it('gives a new file the whole pane', async () => {
    renderDiff({
      path: tab.path,
      original: null,
      modified: { dataUrl: 'data:image/png;base64,NEW', bytes: 4096 },
      tooLarge: false,
    });

    expect(await screen.findByText('Added')).toBeInTheDocument();
    expect(screen.queryByText('Before')).not.toBeInTheDocument();
    expect(screen.getByAltText('logo.png')).toBeInTheDocument();
  });

  it('gives a deleted file the whole pane', async () => {
    renderDiff({
      path: tab.path,
      original: { dataUrl: 'data:image/png;base64,OLD', bytes: 1024 },
      modified: null,
      tooLarge: false,
    });

    expect(await screen.findByText('Deleted')).toBeInTheDocument();
    expect(screen.queryByText('After')).not.toBeInTheDocument();
  });

  it('asks git for the commit version when the tab is pinned to one', async () => {
    const bridge = renderDiff(
      {
        path: tab.path,
        original: null,
        modified: { dataUrl: 'data:image/png;base64,NEW', bytes: 4096 },
        tooLarge: false,
      },
      { ...tab, side: 'staged', commit: 'abc1234', origPath: 'assets/old.png' },
    );

    expect(await screen.findByText('Added')).toBeInTheDocument();
    expect(bridge.$fn('git.commitFileImage')).toHaveBeenCalledWith(
      'p1',
      'abc1234',
      'assets/logo.png',
      'assets/old.png',
    );
    expect(() => bridge.$fn('git.fileImage')).toThrow('has not been touched');
  });

  it('says so when git could not hand a version over', async () => {
    renderDiff(() => Promise.reject(new Error('fatal: bad object')));

    expect(await screen.findByText('This image could not be read')).toBeInTheDocument();
    expect(screen.getByText('fatal: bad object')).toBeInTheDocument();
  });

  it('says so when the picture is too big to load', async () => {
    renderDiff({ path: tab.path, original: null, modified: null, tooLarge: true });

    expect(await screen.findByText('This image is too large to show here')).toBeInTheDocument();
  });
});
