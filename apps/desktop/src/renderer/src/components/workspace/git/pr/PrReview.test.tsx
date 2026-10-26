import type { Project, PrReviewThread, PullRequestInfo } from '@runova/core';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';
import { PrReview } from './PrReview';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

// The shared dialog runs a sizing call and launches a tab; here only the prompt it gets matters.
vi.mock('../../FixWithAiDialog', () => ({
  FixWithAiDialog: ({ title, source }: { title: string; source: { prompt: string | null } }) => (
    <div role="dialog" aria-label={title}>
      <pre>{source.prompt}</pre>
    </div>
  ),
}));

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;

function thread(id: string, overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 12,
    comments: [
      { author: 'rev', body: `First on ${id}`, createdAt: '2026-09-20T10:00:00Z', url: '' },
      { author: 'me', body: `Latest on ${id}`, createdAt: '2026-09-21T10:00:00Z', url: '' },
    ],
    ...overrides,
  };
}

const PR: PullRequestInfo = {
  number: 7,
  title: 'Add the tab',
  url: 'https://github.com/acme/app/pull/7',
  state: 'OPEN',
  isDraft: false,
  base: 'master',
  head: 'feature',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'CHANGES_REQUESTED',
  additions: 1,
  deletions: 0,
  checks: [],
  threads: [thread('T1'), thread('T2', { isResolved: true, path: 'src/b.ts' })],
};

function renderReview(pr: PullRequestInfo = PR, bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<PrReview project={project} pr={pr} />, {
    bridge: {
      'settings.get': { reviewCommands: ['@claude review', '/gemini review'] },
      'pullRequests.status': new Promise(() => {
        // Never settles: the refresh after an action stays in flight, so the cache is what is checked.
      }),
      ...bridge,
    },
  });
}

beforeEach(() => vi.clearAllMocks());

describe('PrReview', () => {
  it('shows the review decision and the open threads, newest comment first in view', () => {
    renderReview();
    expect(screen.getByText('Changes requested')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts:12')).toBeInTheDocument();
    expect(screen.getByText('Latest on T1')).toBeInTheDocument();
    // Older comments fold away behind a toggle, and resolved threads stay hidden.
    expect(screen.queryByText('First on T1')).not.toBeInTheDocument();
    expect(screen.queryByText('Latest on T2')).not.toBeInTheDocument();
  });

  it('unfolds earlier comments and resolved threads on request', async () => {
    const { user } = renderReview();
    await user.click(screen.getByRole('button', { name: 'Show 1 earlier comment' }));
    expect(screen.getByText('First on T1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show 1 resolved' }));
    expect(screen.getByText('Latest on T2')).toBeInTheDocument();
  });

  it('replies with Ctrl+Enter', async () => {
    const { user, bridge } = renderReview(PR, { 'pullRequests.replyThread': { ok: true } });
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    const box = screen.getByRole('textbox', { name: 'Reply to src/a.ts:12' });
    await user.type(box, 'Done{Control>}{Enter}{/Control}');
    await waitFor(() =>
      expect(bridge.$fn('pullRequests.replyThread')).toHaveBeenCalledWith({
        projectId: 'p1',
        threadId: 'T1',
        body: 'Done',
      }),
    );
  });

  it('resolves a thread', async () => {
    const { user, bridge } = renderReview(PR, { 'pullRequests.resolveThread': { ok: true } });
    await user.click(screen.getByRole('button', { name: 'Resolve src/a.ts:12' }));
    expect(bridge.$fn('pullRequests.resolveThread')).toHaveBeenCalledWith({
      projectId: 'p1',
      threadId: 'T1',
      resolved: true,
    });
  });

  it('posts a review bot command from a chip', async () => {
    const { user, bridge } = renderReview(PR, { 'pullRequests.comment': { ok: true } });
    await user.click(await screen.findByRole('button', { name: '/gemini review' }));
    expect(screen.getByRole('textbox', { name: 'Comment on the pull request' })).toHaveValue(
      '/gemini review',
    );
    await user.click(screen.getByRole('button', { name: 'Post comment' }));
    await waitFor(() =>
      expect(bridge.$fn('pullRequests.comment')).toHaveBeenCalledWith({
        projectId: 'p1',
        number: 7,
        body: '/gemini review',
      }),
    );
    expect(await screen.findByText('Posted')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Comment on the pull request' })).toHaveValue('');
  });

  it('hands the open comments to an agent', async () => {
    const { user } = renderReview();
    await user.click(screen.getByRole('button', { name: 'Fix comments with AI' }));
    const dialog = screen.getByRole('dialog', { name: 'Fix review comments with AI' });
    expect(within(dialog).getByText(/Latest on T1/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Latest on T2/)).not.toBeInTheDocument();
  });

  it('has nothing to fix when every thread is resolved', () => {
    renderReview({ ...PR, reviewDecision: null, threads: [thread('T2', { isResolved: true })] });
    expect(screen.queryByRole('button', { name: 'Fix comments with AI' })).not.toBeInTheDocument();
    expect(screen.getByText('No open review comments.')).toBeInTheDocument();
  });

  it('runs a local AI review and posts what the user kept', async () => {
    const { user, bridge } = renderReview(PR, {
      'pullRequests.localReview': { ok: true, text: 'Looks good.', cliName: 'Claude Code' },
      'pullRequests.comment': { ok: true },
    });
    await user.click(screen.getByRole('button', { name: 'Review with AI' }));
    const box = await screen.findByRole('textbox', { name: 'AI review' });
    await waitFor(() => expect(box).toHaveValue('Looks good.'));
    await user.type(box, ' Ship it.');
    await user.click(screen.getByRole('button', { name: 'Post as comment' }));
    await waitFor(() =>
      expect(bridge.$fn('pullRequests.comment')).toHaveBeenCalledWith({
        projectId: 'p1',
        number: 7,
        body: 'Looks good. Ship it.',
      }),
    );
  });
});
