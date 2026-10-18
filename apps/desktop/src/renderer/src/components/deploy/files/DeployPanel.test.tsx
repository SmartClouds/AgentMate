import type { FilesDeployInput, FilesPlanView, FilesRunResult } from '@shared/deployFilesTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { selectSiteRun, useDeployFilesRunStore } from '@/stores/deployFilesRunStore';
import { answerHostKeyPrompt, useHostKeyPromptStore } from '@/stores/hostKeyPromptStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { filterCounts } from './changesTree';
import { DeployPanel } from './DeployPanel';
import { useFilesRunEvents } from './hooks';
import {
  fileSite,
  pending,
  plan,
  planChange,
  progressEvent,
  runResult,
  snapshot,
} from './testing/fixtures';

/**
 * A site's Changes: what changed since the last deploy, the Deploy button, and the whole deploy
 * from there. Checking the server, the review when it needs one, a confirmation for deletes, the
 * progress in place of the button and the outcome after, all without covering the page.
 */

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock('sonner', () => ({ toast }));

// Counts how often the changes list draws: it sums the filter chips once per render.
vi.mock('./changesTree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./changesTree')>();
  return { ...actual, filterCounts: vi.fn(actual.filterCounts) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Events(): null {
  useFilesRunEvents();
  return null;
}

function renderPanel(bridge: Record<string, unknown> = {}, props: { onEdit?: () => void } = {}) {
  const onEdit = props.onEdit ?? vi.fn();
  const onOpenSettings = vi.fn();
  const view = renderWithProviders(
    <>
      <Events />
      <DeployPanel site={fileSite()} onEdit={onEdit} onOpenSettings={onOpenSettings} />
      <ConfirmDialogHost />
    </>,
    {
      bridge: {
        'deployFiles.subscribe': snapshot(),
        'deployFiles.changes': snapshot(),
        ...bridge,
      },
    },
  );
  return { ...view, onEdit, onOpenSettings };
}

function deployButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Deploy \d+ changes?/ });
}

beforeEach(() => {
  useDeployFilesRunStore.setState(useDeployFilesRunStore.getInitialState(), true);
  useHostKeyPromptStore.setState({ request: null });
  for (const fn of Object.values(toast)) fn.mockClear();
});

describe('DeployPanel changes', () => {
  it('shimmers in each card while the first snapshot is on its way', () => {
    const { container } = renderPanel({
      'deployFiles.subscribe': () => new Promise(() => undefined),
      'deployFiles.changes': () => new Promise(() => undefined),
    });
    expect(container.querySelectorAll('[aria-busy="true"] .shimmer').length).toBeGreaterThan(1);
  });

  it('sums up what changed and offers to deploy it', async () => {
    renderPanel();
    expect(await screen.findByText('3 changes, 6.00 KB since the last deploy')).toBeTruthy();
    expect(deployButton().textContent).toBe('Deploy 3 changes (6.00 KB)');
    expect(screen.getByText('Never deployed')).toBeTruthy();
  });

  it('counts only the ticked files on the button', async () => {
    const { user } = renderPanel();
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(screen.getByRole('checkbox', { name: 'Include css/site.css' }));
    expect(deployButton().textContent).toBe('Deploy 2 changes (2.00 KB)');
    await user.click(screen.getByRole('button', { name: 'Select none' }));
    expect(screen.getByRole('button', { name: /Deploy/ }).hasAttribute('disabled')).toBe(true);
  });

  it('says everything is deployed, and when', async () => {
    const at = Date.now() - 5 * 60_000;
    renderWithProviders(
      <DeployPanel
        site={fileSite({
          lastDeploy: { at, state: 'done', trigger: 'user', uploaded: 3, deleted: 0, failed: 0 },
        })}
        onEdit={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
      {
        bridge: {
          'deployFiles.subscribe': snapshot({ files: [] }),
          'deployFiles.changes': snapshot({ files: [] }),
        },
      },
    );
    expect(await screen.findByText('Everything is deployed')).toBeTruthy();
    expect(screen.getByText('Deployed 5 min ago')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Deploy/ })).toBeNull();
  });

  it('keeps the left-out files in reach when nothing is pending', async () => {
    const { user } = renderPanel({
      'deployFiles.subscribe': snapshot({
        files: [],
        leftOut: [{ path: '.env', reason: 'hardDenied' }],
      }),
      'deployFiles.changes': snapshot({
        files: [],
        leftOut: [{ path: '.env', reason: 'hardDenied' }],
      }),
    });
    await screen.findByText('Everything is deployed');
    await user.click(screen.getByRole('button', { name: /Left out 1/ }));
    expect(screen.getByText('.env')).toBeTruthy();
  });

  it('asks for the folder again when it is gone', async () => {
    const onEdit = vi.fn();
    const { user } = renderPanel(
      {
        'deployFiles.subscribe': snapshot({ state: 'folderMissing', files: [] }),
        'deployFiles.changes': snapshot({ state: 'folderMissing', files: [] }),
      },
      { onEdit },
    );
    expect(await screen.findByText(/The deploy folder is gone/)).toBeTruthy();
    expect(screen.getByText('C:\\Sites\\bakery\\dist')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Pick the folder again' }));
    expect(onEdit).toHaveBeenCalled();
  });

  it('points to the ignore lines when the folder has too many files', async () => {
    const { user, onOpenSettings } = renderPanel({
      'deployFiles.subscribe': snapshot({ state: 'tooManyFiles', files: [] }),
      'deployFiles.changes': snapshot({ state: 'tooManyFiles', files: [] }),
    });
    expect(await screen.findByText(/too many files to track/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Edit the ignore lines' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('says why the folder could not be read, and why the list did not load', async () => {
    const { unmount } = renderPanel({
      'deployFiles.subscribe': snapshot({
        state: 'error',
        error: 'EACCES: permission denied',
        files: [],
      }),
      'deployFiles.changes': snapshot({
        state: 'error',
        error: 'EACCES: permission denied',
        files: [],
      }),
    });
    expect(await screen.findByText(/EACCES: permission denied/)).toBeTruthy();
    unmount();

    const again = renderPanel({
      'deployFiles.subscribe': async () => {
        throw new Error('[files:siteUnknown] gone');
      },
      'deployFiles.changes': async () => {
        throw new Error('[files:siteUnknown] gone');
      },
    });
    expect(await screen.findByText(/doesn't know this site anymore/)).toBeTruthy();
    again.bridge.$set('deployFiles.changes', snapshot());
    await again.user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('3 changes, 6.00 KB since the last deploy')).toBeTruthy();
  });

  it('shimmers the list while the folder is first looked through', async () => {
    const { container } = renderPanel({
      'deployFiles.subscribe': snapshot({ state: 'scanning', files: [] }),
      'deployFiles.changes': snapshot({ state: 'scanning', files: [] }),
    });
    expect(await screen.findByText('Looking through the deploy folder…')).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });
});

describe('DeployPanel deploy', () => {
  it('checks the server, confirms the delete, shows progress in place and then the outcome', async () => {
    const planned = deferred<FilesPlanView>();
    const sent = deferred<FilesRunResult>();
    const { user, bridge } = renderPanel({
      'deployFiles.plan': () => planned.promise,
      'deployFiles.deploy': () => sent.promise,
    });
    await screen.findByRole('list', { name: 'Changed files' });

    await user.click(deployButton());
    expect(
      screen.getByRole('button', { name: /Checking the server/ }).hasAttribute('disabled'),
    ).toBe(true);
    expect(bridge.$fn('deployFiles.plan')).toHaveBeenCalledWith({ siteId: 'fs-1' });
    await act(async () => planned.resolve(plan()));

    const dialog = await screen.findByRole('dialog', { name: 'Delete 1 file from the server?' });
    expect(within(dialog).getByText('img/old.png')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete and deploy' }));

    await waitFor(() => expect(bridge.$fn('deployFiles.deploy')).toHaveBeenCalled());
    const input = bridge.$fn('deployFiles.deploy').mock.calls[0][0] as FilesDeployInput;
    expect(input).toEqual({
      siteId: 'fs-1',
      planId: 'plan-1',
      paths: ['index.html', 'css/site.css', 'img/old.png'],
      conflicts: {},
      firstDeploy: null,
      reupload: [],
    });
    expect(await screen.findByRole('region', { name: 'Deploy progress' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Deploy \d/ })).toBeNull();
    expect(
      screen.getByRole('checkbox', { name: 'Include index.html' }).hasAttribute('disabled'),
    ).toBe(true);

    act(() => bridge.$emit('deployFiles.onProgress', progressEvent({ filesDone: 2 })));
    expect(screen.getByText('2 of 3 files')).toBeTruthy();

    await act(async () => sent.resolve(runResult()));
    expect(await screen.findByRole('region', { name: 'Last deploy' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Deploy progress' })).toBeNull();
    expect(toast.success).toHaveBeenCalledTimes(1);
    // The event for the same run comes too, and is not taken twice.
    act(() => bridge.$emit('deployFiles.onRunFinished', runResult()));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('sends only the ticked files that are in the plan, and goes straight on without deletes', async () => {
    const { user, bridge } = renderPanel({
      'deployFiles.plan': plan(),
      'deployFiles.deploy': runResult(),
    });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(screen.getByRole('checkbox', { name: 'Include img/old.png' }));
    await user.click(deployButton());

    await waitFor(() => expect(bridge.$fn('deployFiles.deploy')).toHaveBeenCalled());
    expect(bridge.$fn('deployFiles.deploy').mock.calls[0][0].paths).toEqual([
      'index.html',
      'css/site.css',
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the review up when the deletes are not confirmed', async () => {
    const { user, bridge } = renderPanel({ 'deployFiles.plan': plan() });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(deployButton());
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByRole('region', { name: 'Review before deploying' })).toBeTruthy();
    expect(() => bridge.$fn('deployFiles.deploy')).toThrow();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('region', { name: 'Review before deploying' })).toBeNull();
    expect(deployButton()).toBeTruthy();
  });

  it('stops for conflicts and sends the choices made', async () => {
    const conflicted = plan({
      changes: [
        planChange('index.html', { action: 'conflict', conflict: 'changedOnServer', size: 2048 }),
        planChange('css/site.css', { local: 'added', size: 4096 }),
      ],
    });
    const { user, bridge } = renderPanel({
      'deployFiles.subscribe': snapshot({
        files: [pending('index.html'), pending('css/site.css', 'added')],
      }),
      'deployFiles.changes': snapshot({
        files: [pending('index.html'), pending('css/site.css', 'added')],
      }),
      'deployFiles.plan': conflicted,
      'deployFiles.deploy': runResult(),
    });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(deployButton());

    const review = await screen.findByRole('region', { name: 'Review before deploying' });
    expect(within(review).getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(
      true,
    );
    await user.click(within(review).getByRole('radio', { name: 'Skip' }));
    await user.click(within(review).getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(bridge.$fn('deployFiles.deploy')).toHaveBeenCalled());
    expect(bridge.$fn('deployFiles.deploy').mock.calls[0][0]).toMatchObject({
      paths: ['index.html', 'css/site.css'],
      conflicts: { 'index.html': 'skip' },
    });
  });

  it('sends the first deploy choice and the files picked to upload again', async () => {
    const { user, bridge } = renderPanel({
      'deployFiles.subscribe': snapshot({ files: [pending('index.html')] }),
      'deployFiles.changes': snapshot({ files: [pending('index.html')] }),
      'deployFiles.plan': plan({
        changes: [planChange('index.html')],
        firstDeploy: { existing: 214, sameSize: 200 },
        missingOnServer: ['js/app.js'],
      }),
      'deployFiles.deploy': runResult(),
    });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(deployButton());
    await screen.findByRole('region', { name: 'First deploy' });
    await user.click(screen.getByRole('checkbox', { name: 'Upload js/app.js again' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(bridge.$fn('deployFiles.deploy')).toHaveBeenCalled());
    expect(bridge.$fn('deployFiles.deploy').mock.calls[0][0]).toMatchObject({
      firstDeploy: 'adoptSameSize',
      reupload: ['js/app.js'],
    });
  });

  it('sends nothing when the plan leaves nothing ticked to send', async () => {
    const { user, bridge } = renderPanel({
      'deployFiles.plan': plan({ changes: [planChange('elsewhere.html')] }),
    });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(deployButton());
    expect(await screen.findByText(/Nothing left to send/)).toBeTruthy();
    expect(() => bridge.$fn('deployFiles.deploy')).toThrow();
  });

  it('says why the check failed', async () => {
    const { user } = renderPanel({
      'deployFiles.plan': async () => {
        throw new Error('[files:auth] Permission denied');
      },
    });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(deployButton());
    expect(await screen.findByText(/didn't accept the username/)).toBeTruthy();
    expect(deployButton().hasAttribute('disabled')).toBe(false);
  });

  it('offers to check again when the review expired', async () => {
    const { user, bridge } = renderPanel({
      'deployFiles.subscribe': snapshot({ files: [pending('index.html')] }),
      'deployFiles.changes': snapshot({ files: [pending('index.html')] }),
      'deployFiles.plan': plan({ changes: [planChange('index.html')] }),
      'deployFiles.deploy': async () => {
        throw new Error(
          "Error invoking remote method 'deployFiles:deploy': Error: [files:planExpired] old",
        );
      },
    });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(deployButton());
    expect(await screen.findByText(/The review expired after 10 minutes/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check the server again' }));
    await waitFor(() => expect(bridge.$fn('deployFiles.plan')).toHaveBeenCalledTimes(2));
  });

  it('cancels a running deploy', async () => {
    const { user, bridge } = renderPanel({
      'deployFiles.subscribe': snapshot({ files: [pending('index.html')] }),
      'deployFiles.changes': snapshot({ files: [pending('index.html')] }),
      'deployFiles.plan': plan({ changes: [planChange('index.html')] }),
      'deployFiles.deploy': () => new Promise(() => undefined),
    });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(deployButton());
    await screen.findByRole('region', { name: 'Deploy progress' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.$fn('deployFiles.cancel')).toHaveBeenCalledWith('fs-1');
    expect(screen.getByRole('button', { name: /Cancelling/ })).toBeTruthy();
  });

  it('says so when the cancel itself fails', async () => {
    const { user } = renderPanel({
      'deployFiles.subscribe': snapshot({ files: [pending('index.html')] }),
      'deployFiles.changes': snapshot({ files: [pending('index.html')] }),
      'deployFiles.plan': plan({ changes: [planChange('index.html')] }),
      'deployFiles.deploy': () => new Promise(() => undefined),
      'deployFiles.cancel': async () => {
        throw new Error('[files:siteUnknown] gone');
      },
    });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(deployButton());
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('retries only the failed files', async () => {
    const { user, bridge } = renderPanel({
      'deployFiles.plan': plan(),
      'deployFiles.deploy': runResult({
        state: 'partial',
        failed: [{ path: 'css/site.css', code: 'server', message: '553' }],
      }),
    });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(screen.getByRole('checkbox', { name: 'Include img/old.png' }));
    await user.click(deployButton());
    await screen.findByRole('region', { name: 'Last deploy' });
    expect(toast.warning).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Retry failed/ }));
    await waitFor(() => expect(bridge.$fn('deployFiles.deploy')).toHaveBeenCalledTimes(2));
    expect(bridge.$fn('deployFiles.deploy').mock.calls[1][0].paths).toEqual(['css/site.css']);
  });

  it('shows a Deploy on save run that started on its own', async () => {
    const { bridge } = renderPanel();
    await screen.findByRole('list', { name: 'Changed files' });
    act(() => bridge.$emit('deployFiles.onProgress', progressEvent({ trigger: 'deployOnSave' })));
    expect(await screen.findByText(/Deploy on save is sending your changes/)).toBeTruthy();
  });
});

describe('DeployPanel across remounts and crossing runs', () => {
  const TWO = snapshot({ files: [pending('index.html'), pending('css/site.css', 'added')] });
  const TWO_PLANNED = plan({
    changes: [planChange('index.html'), planChange('css/site.css', { local: 'added' })],
  });

  it('keeps the unticked files out after the panel was left and opened again', async () => {
    const bridge = {
      'deployFiles.subscribe': TWO,
      'deployFiles.changes': TWO,
      'deployFiles.plan': { ...TWO_PLANNED, massDelete: true },
      'deployFiles.deploy': runResult(),
    };
    const first = renderPanel(bridge);
    await screen.findByRole('list', { name: 'Changed files' });
    await first.user.click(screen.getByRole('checkbox', { name: 'Include css/site.css' }));
    await first.user.click(deployButton());
    await screen.findByRole('region', { name: 'Review before deploying' });
    first.unmount();

    const again = renderPanel(bridge);
    await screen.findByRole('list', { name: 'Changed files' });
    expect(
      screen.getByRole('checkbox', { name: 'Include css/site.css' }).getAttribute('aria-checked'),
    ).toBe('false');
    const review = screen.getByRole('region', { name: 'Review before deploying' });
    await again.user.click(within(review).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(again.bridge.$fn('deployFiles.deploy')).toHaveBeenCalled());
    expect(again.bridge.$fn('deployFiles.deploy').mock.calls[0][0].paths).toEqual(['index.html']);
  });

  it('drops a check that comes back after a Deploy on save run started', async () => {
    const planned = deferred<FilesPlanView>();
    const { user, bridge } = renderPanel({
      'deployFiles.subscribe': TWO,
      'deployFiles.changes': TWO,
      'deployFiles.plan': () => planned.promise,
    });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(deployButton());
    act(() =>
      bridge.$emit(
        'deployFiles.onProgress',
        progressEvent({ runId: 'run-2', trigger: 'deployOnSave', filesDone: 1 }),
      ),
    );
    await act(async () => planned.resolve(TWO_PLANNED));

    expect(screen.getByRole('region', { name: 'Deploy progress' })).toBeTruthy();
    expect(screen.getByText('1 of 3 files')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Review before deploying' })).toBeNull();
    expect(() => bridge.$fn('deployFiles.deploy')).toThrow();
    expect(selectSiteRun('fs-1')(useDeployFilesRunStore.getState()).review).toBeNull();
  });

  it('sends nothing when the review went away while the deletes were being confirmed', async () => {
    const { user, bridge } = renderPanel({ 'deployFiles.plan': plan() });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(deployButton());
    const dialog = await screen.findByRole('dialog', { name: 'Delete 1 file from the server?' });
    act(() =>
      bridge.$emit(
        'deployFiles.onProgress',
        progressEvent({ runId: 'run-2', trigger: 'deployOnSave' }),
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Delete and deploy' }));
    await act(async () => undefined);
    expect(() => bridge.$fn('deployFiles.deploy')).toThrow();
    expect(screen.getByRole('region', { name: 'Deploy progress' })).toBeTruthy();
  });

  it('does not draw the list again for every progress reading', async () => {
    const { bridge } = renderPanel();
    await screen.findByRole('list', { name: 'Changed files' });
    act(() => bridge.$emit('deployFiles.onProgress', progressEvent({ trigger: 'deployOnSave' })));
    await screen.findByRole('region', { name: 'Deploy progress' });
    const draws = vi.mocked(filterCounts).mock.calls.length;
    for (let index = 2; index < 7; index += 1) {
      act(() =>
        bridge.$emit(
          'deployFiles.onProgress',
          progressEvent({ trigger: 'deployOnSave', bytesDone: index * 512 }),
        ),
      );
    }
    expect(screen.getByText('3.00 KB of 6.00 KB')).toBeTruthy();
    expect(vi.mocked(filterCounts).mock.calls.length).toBe(draws);
  });
});

describe('DeployPanel host keys and certificates', () => {
  const status = {
    serverId: 'fs-1',
    nickname: 'Bakery static',
    host: 'files.example',
    port: 22,
    stored: 'ab'.repeat(32),
    presented: 'cd'.repeat(32),
  };
  const ONE = snapshot({ files: [pending('index.html')] });

  it('asks about a changed host key during the check and goes on once it is trusted', async () => {
    let calls = 0;
    const trust = vi.fn(async () => undefined);
    const { user, bridge } = renderPanel({
      'deployFiles.subscribe': ONE,
      'deployFiles.changes': ONE,
      'deployFiles.plan': async () => {
        calls += 1;
        if (calls === 1) throw new Error('[files:hostKeyChanged] changed');
        return plan({ changes: [planChange('index.html')] });
      },
      'deployFiles.hostKeyStatus': status,
      'deployFiles.trustHostKey': trust,
      'deployFiles.deploy': runResult(),
    });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(deployButton());
    await waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    await act(async () => answerHostKeyPrompt(true));

    await waitFor(() => expect(bridge.$fn('deployFiles.deploy')).toHaveBeenCalled());
    expect(trust).toHaveBeenCalledWith('fs-1', status.presented);
    expect(bridge.$fn('deployFiles.plan')).toHaveBeenCalledTimes(2);
  });

  it('asks about a changed host key when the deploy itself connects', async () => {
    let calls = 0;
    const { user, bridge } = renderPanel({
      'deployFiles.subscribe': ONE,
      'deployFiles.changes': ONE,
      'deployFiles.plan': plan({ changes: [planChange('index.html')] }),
      'deployFiles.hostKeyStatus': status,
      'deployFiles.trustHostKey': async () => undefined,
      'deployFiles.deploy': async () => {
        calls += 1;
        if (calls === 1) throw new Error('[files:hostKeyChanged] changed');
        return runResult();
      },
    });
    await screen.findByRole('list', { name: 'Changed files' });
    await user.click(deployButton());
    await waitFor(() => expect(useHostKeyPromptStore.getState().request).not.toBeNull());
    await act(async () => answerHostKeyPrompt(true));
    expect(await screen.findByRole('region', { name: 'Last deploy' })).toBeTruthy();
    expect(bridge.$fn('deployFiles.deploy')).toHaveBeenCalledTimes(2);
  });

  it.each(['tlsUntrusted', 'tlsNameMismatch', 'hostKeyUnknown'])(
    'offers to edit the site after a %s failure',
    async (code) => {
      const onEdit = vi.fn();
      const { user } = renderPanel(
        {
          'deployFiles.plan': async () => {
            throw new Error(`[files:${code}] no`);
          },
        },
        { onEdit },
      );
      await screen.findByRole('list', { name: 'Changed files' });
      await user.click(deployButton());
      await user.click(await screen.findByRole('button', { name: 'Edit the site' }));
      expect(onEdit).toHaveBeenCalled();
    },
  );
});
