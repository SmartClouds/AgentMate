// @vitest-environment jsdom
import type { Project } from '@runova/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useEditorRevealStore } from '@/stores/editorRevealStore';
import { useWorkspaceStore, type WorkspaceFileTab } from '@/stores/workspaceStore';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';

// Monaco needs a real layout engine, and neither test below is about the editor itself.
const revealed = vi.hoisted(() => [] as string[]);
vi.mock('@/components/editor/MonacoEditor', async () => {
  const { useEffect } = await import('react');
  return {
    MonacoEditor: ({
      value,
      onChange,
      reveal,
      onRevealed,
    }: {
      value: string;
      onChange?: (value: string) => void;
      reveal?: { line: number; column: number } | null;
      onRevealed?: () => void;
    }) => {
      useEffect(() => {
        if (!reveal) return;
        revealed.push(`${reveal.line}:${reveal.column}`);
        onRevealed?.();
      }, [reveal, onRevealed]);
      return (
        <>
          <div data-testid="monaco">{value}</div>
          <button type="button" onClick={() => onChange?.(`${value} edited`)}>
            type
          </button>
        </>
      );
    },
  };
});
vi.mock('@/components/editor/MonacoDiffEditor', () => ({ languageFor: () => 'plaintext' }));

const FileTab = (await import('./FileTab')).default;

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;

function tab(path: string, preview = false): WorkspaceFileTab {
  return { kind: 'file', id: 't1', path, preview };
}

/** A fresh cache per test, so one test's picture is never the next one's cached answer. */
let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function wrap(fileTab: WorkspaceFileTab): React.JSX.Element {
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <FileTab project={project} tab={fileTab} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function renderTab(fileTab: WorkspaceFileTab) {
  return render(wrap(fileTab));
}

afterEach(cleanup);

describe('FileTab', () => {
  it('shows a picture in the viewer instead of its bytes', async () => {
    installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/png;base64,AAA', bytes: 2048 },
    });
    renderTab(tab('E:\\work\\app\\assets\\logo.png'));

    const image = await screen.findByAltText('logo.png');
    expect(image).toHaveAttribute('src', 'data:image/png;base64,AAA');
    expect(screen.queryByTestId('monaco')).not.toBeInTheDocument();
    expect(await screen.findByText('2.00 KB')).toBeInTheDocument();
  });

  it('says why an image could not be opened', async () => {
    installRunovaBridge({
      'fs.readImage': () => Promise.reject(new Error('This image is too large to show here.')),
    });
    renderTab(tab('E:\\work\\app\\assets\\huge.png'));

    expect(await screen.findByText('This image could not be opened')).toBeInTheDocument();
    expect(screen.getByText('This image is too large to show here.')).toBeInTheDocument();
  });

  it('lets an SVG switch between the picture and its source', async () => {
    installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/svg+xml;base64,BBB', bytes: 300 },
      'fs.readFile': () => '<svg />',
    });
    renderTab(tab('E:\\work\\app\\assets\\icon.svg'));

    expect(await screen.findByAltText('icon.svg')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Edit the source'));
    expect(await screen.findByTestId('monaco')).toHaveTextContent('<svg />');

    fireEvent.click(screen.getByLabelText('Show the picture'));
    await waitFor(() => expect(screen.getByAltText('icon.svg')).toBeInTheDocument());
  });

  it('re-reads the file from disk on demand', async () => {
    const bridge = installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/png;base64,AAA', bytes: 2048 },
    });
    renderTab(tab('E:\\work\\app\\assets\\logo.png'));
    await screen.findByAltText('logo.png');
    expect(bridge.$fn('fs.readImage')).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Reload from disk'));
    await waitFor(() => expect(bridge.$fn('fs.readImage')).toHaveBeenCalledTimes(2));
  });

  it('hands the picture to its default app when asked', async () => {
    const bridge = installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/png;base64,AAA', bytes: 2048 },
    });
    renderTab(tab('E:\\work\\app\\assets\\logo.png'));
    await screen.findByAltText('logo.png');

    fireEvent.click(screen.getByLabelText('Open in its default app'));
    expect(bridge.$fn('shell.openPath')).toHaveBeenCalledWith('E:\\work\\app\\assets\\logo.png');
  });

  it('does not offer the source of a picture that has none', async () => {
    installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/png;base64,AAA', bytes: 2048 },
    });
    renderTab(tab('E:\\work\\app\\assets\\logo.png'));
    await screen.findByAltText('logo.png');
    expect(screen.queryByLabelText('Edit the source')).not.toBeInTheDocument();
  });

  it('goes back to the viewer when the tab is reused for another file', async () => {
    installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/svg+xml;base64,BBB', bytes: 300 },
      'fs.readFile': () => '<svg />',
    });
    const view = renderTab(tab('E:\\work\\app\\assets\\icon.svg'));
    await screen.findByAltText('icon.svg');
    fireEvent.click(screen.getByLabelText('Edit the source'));
    expect(await screen.findByTestId('monaco')).toBeInTheDocument();

    // A preview tab is reused for the next file clicked, which is a new picture, not source.
    view.rerender(wrap(tab('E:\\work\\app\\assets\\other.svg')));
    expect(await screen.findByAltText('other.svg')).toBeInTheDocument();
  });

  it('opens at the line a search result asked for, once', async () => {
    installRunovaBridge({ 'fs.readFile': () => 'a\nb\nc\n' });
    const path = 'E:\\work\\app\\src\\index.ts';
    useEditorRevealStore.getState().requestReveal(path, { line: 3, column: 2 });
    renderTab(tab(path));

    await screen.findByTestId('monaco');
    // Taken as it is applied, so switching back to the tab later does not jump again.
    await waitFor(() => expect(useEditorRevealStore.getState().pending[path]).toBeUndefined());
    expect(revealed).toEqual(['3:2']);
  });

  it("shows the new file, not the last one's edits, when a preview tab moves on", async () => {
    const texts: Record<string, string> = {
      'E:\\work\\app\\README.md': '# Readme',
      'E:\\work\\app\\docs\\guide.md': '# Guide',
      'E:\\work\\app\\docs\\notes.md': '# Notes',
    };
    installRunovaBridge({ 'fs.readFile': (path: string) => texts[path] });
    const view = renderTab(tab('E:\\work\\app\\README.md', true));
    expect(await screen.findByTestId('monaco')).toHaveTextContent('# Readme');
    fireEvent.click(screen.getByText('type'));
    expect(screen.getByTestId('monaco')).toHaveTextContent('# Readme edited');

    // Clicking through files quickly reuses the same tab for each one.
    view.rerender(wrap(tab('E:\\work\\app\\docs\\guide.md', true)));
    expect(await screen.findByText('# Guide')).toBeInTheDocument();
    view.rerender(wrap(tab('E:\\work\\app\\docs\\notes.md', true)));
    expect(await screen.findByText('# Notes')).toBeInTheDocument();
    expect(screen.queryByText('Unsaved')).not.toBeInTheDocument();
  });

  it('pins a preview tab once its file is edited', async () => {
    const openFile = vi.fn();
    const original = useWorkspaceStore.getState().openFile;
    useWorkspaceStore.setState({ openFile });
    try {
      installRunovaBridge({ 'fs.readFile': () => '# Readme' });
      renderTab(tab('E:\\work\\app\\README.md', true));
      await screen.findByTestId('monaco');
      fireEvent.click(screen.getByText('type'));
      expect(openFile).toHaveBeenCalledWith('p1', 'E:\\work\\app\\README.md', { pin: true });
    } finally {
      useWorkspaceStore.setState({ openFile: original });
    }
  });

  it('keeps a plain file in the editor', async () => {
    installRunovaBridge({ 'fs.readFile': () => 'const a = 1;\n' });
    renderTab(tab('E:\\work\\app\\src\\index.ts'));

    expect(await screen.findByTestId('monaco')).toHaveTextContent('const a = 1;');
    expect(screen.queryByLabelText('Show the picture')).not.toBeInTheDocument();
  });
});
