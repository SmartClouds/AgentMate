import type { Project } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '@/stores/browserStore';
import type { BrowserAnnotation, PickPayload } from './types';

const deliverToAgent = vi.fn();
const success = vi.fn();
vi.mock('sonner', () => ({ toast: { success, error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/workspace/agentSend', () => ({
  deliverToAgent: (...args: unknown[]) => deliverToAgent(...args),
}));

const { copyAnnotations, copyElementContext, sendAnnotations } = await import('./sendAnnotations');

const project = { id: 'p1', folderPath: '/repo', cliId: null } as unknown as Project;

const payload = {
  page: {
    url: 'http://localhost:5173/',
    title: 'Home',
    viewport: { width: 1280, height: 800 },
    dpr: 1,
  },
  element: {
    tagName: 'button',
    selector: 'button.save',
    path: 'main > button.save',
    role: 'button',
    name: 'Save',
    text: 'Save',
    html: '<button class="save">Save</button>',
    attributes: {},
    styles: {},
    react: null,
    rectViewport: { x: 0, y: 0, width: 10, height: 10 },
    rectPage: { x: 0, y: 0, width: 10, height: 10 },
    fixed: false,
  },
} satisfies PickPayload;

function add(comment: string): string {
  return useBrowserStore.getState().addAnnotation({
    tabId: 'b1',
    ...payload,
    comment,
    intent: 'change',
    preset: null,
    screenshotPath: null,
    thumbDataUrl: null,
  }) as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  useBrowserStore.setState({ annotations: {}, recentUrls: {} });
});

describe('sendAnnotations', () => {
  it('sends every comment of the tab as one prompt and clears them once pasted', async () => {
    add('Bigger');
    add('Greener');
    deliverToAgent.mockImplementation(async (_project, options) => {
      const text = options.build('claude-code') as string;
      expect(text).toContain('**Comment:** Bigger');
      expect(text).toContain('**Comment:** Greener');
      return { outcome: 'pasted', tabId: 't1', cliId: 'claude-code' };
    });
    expect(await sendAnnotations(project, 'b1')).toBe(true);
    expect(deliverToAgent).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ what: 'Your comments' }),
    );
    expect(useBrowserStore.getState().annotations.b1).toBeUndefined();
    expect(success).toHaveBeenCalledWith(
      'Sent 2 comments to Claude Code CLI',
      expect.objectContaining({ description: 'Press Enter in the terminal to send them.' }),
    );
  });

  it('passes the chosen agent along', async () => {
    add('Bigger');
    deliverToAgent.mockResolvedValue({ outcome: 'launched', tabId: 'n', cliId: 'codex-cli' });
    await sendAnnotations(project, 'b1', { newCliId: 'codex-cli' });
    expect(deliverToAgent).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ target: { newCliId: 'codex-cli' } }),
    );
    expect(success).toHaveBeenCalledWith('Sent 1 comment to Codex CLI', expect.anything());
  });

  it('keeps the comments when they only made it to the clipboard or nowhere', async () => {
    add('Bigger');
    deliverToAgent.mockResolvedValue({ outcome: 'clipboard', tabId: 't1', cliId: 'claude-code' });
    expect(await sendAnnotations(project, 'b1')).toBe(false);
    deliverToAgent.mockResolvedValue(null);
    expect(await sendAnnotations(project, 'b1')).toBe(false);
    expect(useBrowserStore.getState().annotations.b1).toHaveLength(1);
  });

  it('keeps a comment added while the send was on its way', async () => {
    add('Bigger');
    deliverToAgent.mockImplementation(async () => {
      add('Added meanwhile');
      return { outcome: 'pasted', tabId: 't1', cliId: 'claude-code' };
    });
    await sendAnnotations(project, 'b1');
    expect(useBrowserStore.getState().annotations.b1?.map((one) => one.comment)).toEqual([
      'Added meanwhile',
    ]);
  });

  it('does nothing without comments', async () => {
    expect(await sendAnnotations(project, 'b1')).toBe(false);
    expect(deliverToAgent).not.toHaveBeenCalled();
  });
});

describe('copying', () => {
  it('copies the comments as the same prompt, keeping them', async () => {
    add('Bigger');
    await copyAnnotations('b1');
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0];
    expect(text).toContain('**Comment:** Bigger');
    expect(useBrowserStore.getState().annotations.b1 as BrowserAnnotation[]).toHaveLength(1);
    expect(success).toHaveBeenCalledWith('Copied 1 comment');
  });

  it('copies one element’s details', async () => {
    await copyElementContext(payload);
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0];
    expect(text).toContain('**Selector:** `button.save`');
    expect(success).toHaveBeenCalledWith('Copied button "Save"', expect.anything());
  });
});
