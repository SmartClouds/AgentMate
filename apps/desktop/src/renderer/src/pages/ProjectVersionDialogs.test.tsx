import type { GitStatus, GitTagInfo } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The "Tag a version" flow, from the form through "Update version in files" and back.
 *
 * What these guard above all is that the form survives the trip. The dialogs are unmounted
 * and remounted constantly (the handoff between the two of them, switching Workspace
 * projects, following the run's toast from the project page to the Workspace), and a version
 * the user got from "Suggest with AI" is expensive to ask for twice.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

// Monaco's real module pulls in Vite `?worker` imports that only exist in a Vite build, and
// the file review renders a diff editor. Stand-ins keep this suite in jsdom.
vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value }: { value: string }) => (
    <textarea aria-label="Editor" readOnly value={value} />
  ),
}));
vi.mock('@/components/editor/MonacoDiffEditor', () => ({
  MonacoDiffEditor: () => <div />,
  languageFor: () => 'plaintext',
}));

const { ProjectVersionDialogs } = await import('./ProjectDetailPage');
const { useVersionDialogStore } = await import('@/stores/versionDialogStore');
const { useConfirmStore } = await import('@/stores/confirmStore');

const status = {
  isRepo: true,
  branch: 'master',
  defaultBranch: 'master',
  hasRemote: true,
  ahead: 0,
  behind: 0,
  files: [],
  branches: [],
} as unknown as GitStatus;

const tags = {
  latestTag: 'v1.0.0',
  commitsSinceLatestTag: 3,
  recentTags: ['v1.0.0'],
  prefixes: ['v'],
  hasRemote: true,
} as unknown as GitTagInfo;

const failedRun = { ok: false, output: '', changes: [], error: 'The CLI exited with code 1.' };

type Bridge = Record<string, unknown>;

function renderDialogs(bridge: Bridge = {}) {
  return renderWithProviders(<ProjectVersionDialogs projectId="p1" open onOpenChange={vi.fn()} />, {
    bridge: { 'git.status': status, 'git.tags': tags, ...bridge },
  });
}

function versionInput(): HTMLInputElement {
  return screen.getByLabelText('Version') as HTMLInputElement;
}

function messageInput(): HTMLTextAreaElement {
  return screen.getByLabelText('Tag message (optional)') as HTMLTextAreaElement;
}

/** Both the failure banner and the footer offer one, and either is the same retry. */
function retryButton(): HTMLElement {
  return screen.getAllByRole('button', { name: /Try again/ })[0] as HTMLElement;
}

beforeEach(() => {
  useVersionDialogStore.setState({ openProjectId: null, applyTags: {}, drafts: {} });
  localStorage.clear();
  vi.clearAllMocks();
});

describe('ProjectVersionDialogs', () => {
  it('keeps the version and message when a failed run is retried and the user goes back', async () => {
    const { user } = renderDialogs({ 'git.applyVersion': async () => failedRun });

    await user.type(await screen.findByLabelText('Version'), '1.1.0');
    await user.type(messageInput(), 'Ship the thing');

    await user.click(screen.getByRole('button', { name: /Update version in files/ }));
    await waitFor(() => expect(retryButton()).toBeTruthy());
    await user.click(retryButton());
    await waitFor(() => expect(retryButton()).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /Back to tag/ }));

    expect((await screen.findByLabelText('Version')).getAttribute('value')).toBe('1.1.0');
    expect(messageInput().value).toBe('Ship the thing');
  });

  it('keeps the form when the dialogs are remounted mid-run', async () => {
    // What a "Review" click on the run's toast does: the project page unmounts, the Workspace
    // mounts its own copy of these dialogs, and the same run is picked up there.
    const first = renderDialogs({ 'git.applyVersion': async () => failedRun });

    await first.user.type(await screen.findByLabelText('Version'), '2.0.0');
    await first.user.type(messageInput(), 'A big one');
    await first.user.click(screen.getByRole('button', { name: /Update version in files/ }));
    await waitFor(() => expect(retryButton()).toBeTruthy());
    first.unmount();

    const second = renderDialogs({ 'git.applyVersion': async () => failedRun });
    await waitFor(() => expect(retryButton()).toBeTruthy());
    await second.user.click(screen.getByRole('button', { name: /Back to tag/ }));

    expect((await screen.findByLabelText('Version')).getAttribute('value')).toBe('2.0.0');
    expect(messageInput().value).toBe('A big one');
    // The step it already ran for is remembered too, so creating the tag doesn't ask the user
    // to confirm skipping a step they did run.
    expect(screen.getByText(/Files updated to/)).toBeTruthy();
  });

  it('keeps a suggested version when the dialogs are remounted', async () => {
    const suggestTag = vi.fn(async () => ({
      ok: true,
      tag: 'v1.1.0',
      reason: 'Two features since v1.0.0.',
      message: 'Adds the widget.',
      cliName: 'Claude',
    }));
    const first = renderDialogs({ 'git.suggestTag': suggestTag });

    await first.user.click(await screen.findByRole('button', { name: /Suggest with AI/ }));
    await waitFor(() => expect(versionInput().value).toBe('1.1.0'));
    first.unmount();

    renderDialogs({ 'git.suggestTag': suggestTag });

    expect((await screen.findByLabelText('Version')).getAttribute('value')).toBe('1.1.0');
    expect(messageInput().value).toBe('Adds the widget.');
    expect(screen.getByText('Two features since v1.0.0.')).toBeTruthy();
    // The point of keeping it: the CLI is not asked a second time.
    expect(suggestTag).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed version commit on screen and stops the tag from skipping past it', async () => {
    // The commit used to fail at random when another git held .git/index.lock. The error was
    // a toast that was easy to miss, and "Back to tag" then led straight into tagging a commit
    // that still had the old version, with only a soft "uncommitted files" note to go on.
    const lockError =
      "fatal: Unable to create 'E:/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository";
    const bump = {
      path: 'package.json',
      kind: 'modified',
      beforeId: 'a'.repeat(40),
      afterId: 'b'.repeat(40),
      beforeRawId: null,
      afterRawId: null,
      additions: 1,
      deletions: 1,
      diff: '@@ -1 +1 @@\n-{ "version": "1.0.0" }\n+{ "version": "1.1.0" }',
    };
    const createTag = vi.fn();
    const { user } = renderDialogs({
      'git.status': { ...status, files: [{ x: ' ', y: 'M', path: 'package.json' }] },
      'git.applyVersion': async () => ({ ok: true, output: '', changes: [bump] }),
      'git.commit': async () => ({ ok: false, message: lockError }),
      'git.createTag': createTag,
    });

    await user.type(await screen.findByLabelText('Version'), '1.1.0');
    await user.click(screen.getByRole('button', { name: /Update version in files/ }));
    const decision = await screen.findByRole('group', { name: 'Decision for package.json' });
    await user.click(within(decision).getByRole('button', { name: /Keep/ }));
    const commit = await screen.findByRole('button', { name: /Commit 1 kept file/ });
    await waitFor(() => expect(commit.hasAttribute('disabled')).toBe(false));
    await user.click(commit);

    expect(await screen.findByText(/The commit failed/)).toBeTruthy();
    expect(screen.getByText(/index\.lock': File exists/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Back to tag/ }));
    expect(await screen.findByText(/isn't committed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Review and commit/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Create & push tag/ }));
    await waitFor(() =>
      expect(useConfirmStore.getState().title).toBe('Version bump not committed'),
    );
    expect(createTag).not.toHaveBeenCalled();
  });

  it('cuts a beta from the bump buttons and goes back to stable', async () => {
    const { user } = renderDialogs();

    await user.click(await screen.findByRole('radio', { name: 'Beta' }));
    await user.click(screen.getByRole('button', { name: 'Patch bump to v1.0.1-beta.1' }));
    expect(versionInput().value).toBe('1.0.1-beta.1');
    expect(screen.getByText(/A beta pre-release/)).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: 'Stable' }));
    expect(versionInput().value).toBe('1.0.1');
    expect(screen.getByRole('radio', { name: 'Stable' }).getAttribute('aria-checked')).toBe('true');
  });

  it('numbers the next beta after the ones already tagged', async () => {
    const { user } = renderDialogs({
      'git.tags': {
        ...tags,
        latestTag: 'v1.1.0-beta.2',
        recentTags: ['v1.1.0-beta.2', 'v1.1.0-beta.1', 'v1.0.0'],
      },
    });

    // The typed channel picks the radio, and the bumps follow it. 1.1.0 itself hasn't shipped,
    // so a minor bump lands on it rather than skipping to 1.2.0.
    await user.type(await screen.findByLabelText('Version'), '1.1.0-beta.1');
    expect(screen.getByRole('radio', { name: 'Beta' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Minor bump to v1.1.0-beta.3' }));
    expect(versionInput().value).toBe('1.1.0-beta.3');

    await user.click(screen.getByRole('radio', { name: 'Stable' }));
    expect(versionInput().value).toBe('1.1.0');
    expect(screen.getByRole('button', { name: 'Minor bump to v1.1.0' })).toBeTruthy();
  });

  it('puts an AI suggestion on the chosen channel', async () => {
    const suggestTag = vi.fn(async () => ({ ok: true, tag: 'v1.1.0', cliName: 'Claude' }));
    const { user } = renderDialogs({ 'git.suggestTag': suggestTag });

    await user.click(await screen.findByRole('radio', { name: 'Preview' }));
    await user.click(screen.getByRole('button', { name: /Suggest with AI/ }));

    await waitFor(() => expect(versionInput().value).toBe('1.1.0-preview.1'));
    expect(toast.success).toHaveBeenCalledWith('Claude suggested v1.1.0-preview.1.');
  });

  it('starts fresh after the user closes the flow', async () => {
    const { user, unmount } = renderDialogs();

    await user.type(await screen.findByLabelText('Version'), '3.0.0');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    unmount();

    renderDialogs();
    expect((await screen.findByLabelText('Version')).getAttribute('value')).toBe('');
  });
});
