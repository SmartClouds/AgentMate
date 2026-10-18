import type { FileSite, FileSiteInput } from '@shared/deployFilesTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { queryKeys } from '@/lib/queryKeys';
import { useDeployFilesRunStore } from '@/stores/deployFilesRunStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { type FileSiteSection, FileSiteView, fileSectionFromView } from './FileSiteView';
import { fileSite, plan, runResult, snapshot } from './testing/fixtures';

/**
 * An FTP or SFTP site's page under Deploy: the header with what matters about the connection,
 * then Changes (the default), History and Settings.
 */

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock('sonner', () => ({ toast }));

function Harness({
  site,
  initial = 'changes',
  onEdit = vi.fn(),
  onRemoved = vi.fn(),
}: {
  site: FileSite;
  initial?: FileSiteSection;
  onEdit?: () => void;
  onRemoved?: () => void;
}) {
  const [section, setSection] = useState<FileSiteSection>(initial);
  return (
    <>
      <FileSiteView
        site={site}
        section={section}
        onSectionChange={setSection}
        onEdit={onEdit}
        onRemoved={onRemoved}
      />
      <ConfirmDialogHost />
    </>
  );
}

function renderView(
  site: FileSite = fileSite(),
  bridge: Record<string, unknown> = {},
  props: Partial<Parameters<typeof Harness>[0]> = {},
) {
  return renderWithProviders(<Harness site={site} {...props} />, {
    bridge: {
      'deployFiles.subscribe': snapshot(),
      'deployFiles.changes': snapshot(),
      ...bridge,
    },
  });
}

function sections(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Site sections' });
}

beforeEach(() => {
  useDeployFilesRunStore.setState(useDeployFilesRunStore.getInitialState(), true);
  for (const fn of Object.values(toast)) fn.mockClear();
});

describe('fileSectionFromView', () => {
  it('reads a section from the address, and Changes for anything else', () => {
    expect(fileSectionFromView('history')).toBe('history');
    expect(fileSectionFromView('settings')).toBe('settings');
    expect(fileSectionFromView('nonsense')).toBe('changes');
    expect(fileSectionFromView(null)).toBe('changes');
  });
});

describe('FileSiteView header', () => {
  it('names the site, its address, protocol and last deploy', async () => {
    renderView(
      fileSite({
        deployOnSave: true,
        lastDeploy: {
          at: Date.now() - 3_600_000 * 2,
          state: 'done',
          trigger: 'user',
          uploaded: 1,
          deleted: 0,
          failed: 0,
        },
      }),
    );
    expect(screen.getByRole('heading', { name: 'Bakery static' })).toBeTruthy();
    const header = screen
      .getByRole('heading', { name: 'Bakery static' })
      .closest('header') as HTMLElement;
    expect(within(header).getByText('deploy@files.example:/var/www/site')).toBeTruthy();
    expect(within(header).getAllByText('SFTP').length).toBeGreaterThan(0);
    expect(within(header).getByText('Deploy on save')).toBeTruthy();
    expect(within(header).getByText('Deployed 2 h ago')).toBeTruthy();
    expect(within(header).queryByText('Not encrypted')).toBeNull();
    await screen.findByText('3 changes, 6.00 KB since the last deploy');
  });

  it('warns about plain FTP and names a saved server', async () => {
    renderView(fileSite({ protocol: 'ftp', connection: { kind: 'saved', sshServerId: 'srv-1' } }), {
      'ssh.listServers': [{ id: 'srv-1', nickname: 'Production' }],
    });
    expect(screen.getByText('Not encrypted')).toBeTruthy();
    expect(await screen.findByText('Production:/var/www/site')).toBeTruthy();
  });

  it('counts the pending changes on the Changes section', async () => {
    renderView();
    await screen.findByText('3 changes, 6.00 KB since the last deploy');
    expect(within(sections()).getByRole('button', { name: /Changes\s*3/ })).toBeTruthy();
  });
});

describe('FileSiteView needs review', () => {
  it('explains why Deploy on save stopped and starts the review from there', async () => {
    const { user, bridge } = renderView(
      fileSite({
        deployOnSave: true,
        needsReview: {
          reason: 'conflicts',
          message: '2 files changed on the server.',
          at: Date.now(),
        },
      }),
      { 'deployFiles.plan': () => new Promise(() => undefined) },
      { initial: 'history' },
    );
    const notice = screen.getByRole('status', { name: 'Deploy on save stopped' });
    expect(
      within(notice).getByText('Deploy on save stopped: some files need your choice'),
    ).toBeTruthy();
    expect(within(notice).getByText('2 files changed on the server.')).toBeTruthy();
    await user.click(within(notice).getByRole('button', { name: 'Review the changes' }));
    await waitFor(() =>
      expect(bridge.$fn('deployFiles.plan')).toHaveBeenCalledWith({ siteId: 'fs-1' }),
    );
    expect(within(sections()).getByRole('button', { name: /Changes/, current: true })).toBeTruthy();
  });

  it('checks the server once per click, not again on every return to Changes', async () => {
    const { user, bridge } = renderView(
      fileSite({
        deployOnSave: true,
        needsReview: { reason: 'massDelete', message: '40 files would go.', at: Date.now() },
      }),
      { 'deployFiles.plan': plan({ massDelete: true, changes: [] }), 'deployFiles.history': [] },
    );
    await screen.findByText('3 changes, 6.00 KB since the last deploy');
    await user.click(screen.getByRole('button', { name: 'Review the changes' }));
    expect(await screen.findByRole('region', { name: 'Review before deploying' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back' }));

    await user.click(within(sections()).getByRole('button', { name: /History/ }));
    await user.click(within(sections()).getByRole('button', { name: /Changes/ }));
    await screen.findByText('3 changes, 6.00 KB since the last deploy');
    await act(async () => undefined);
    expect(screen.queryByRole('region', { name: 'Review before deploying' })).toBeNull();
    expect(bridge.$fn('deployFiles.plan')).toHaveBeenCalledTimes(1);
  });

  it('has its own words for each reason', () => {
    const { unmount } = renderView(
      fileSite({ needsReview: { reason: 'massDelete', message: 'm', at: 1 } }),
    );
    expect(screen.getByText(/this deploy would delete many files/)).toBeTruthy();
    unmount();
    const second = renderView(fileSite({ needsReview: { reason: 'failed', message: 'm', at: 1 } }));
    expect(screen.getByText(/after a deploy failed/)).toBeTruthy();
    second.unmount();
    renderView(fileSite({ needsReview: { reason: 'paused', message: 'm', at: 1 } }));
    expect(screen.getByText('Deploy on save is paused')).toBeTruthy();
  });
});

describe('FileSiteView history', () => {
  it('lists the runs with their state, counts, duration, time and who started them', async () => {
    const { user } = renderView(
      fileSite(),
      {
        'deployFiles.history': [
          runResult({
            runId: 'r2',
            state: 'partial',
            trigger: 'deployOnSave',
            startedAt: Date.now() - 65_000,
            finishedAt: Date.now() - 60_000,
            failed: [{ path: 'big.zip', code: 'diskFull', message: '' }],
          }),
          runResult({
            runId: 'r1',
            startedAt: Date.now() - 86_400_000 * 3,
            finishedAt: Date.now() - 86_400_000 * 3 + 2000,
          }),
        ],
      },
      { initial: 'history' },
    );

    const list = await screen.findByRole('list', { name: 'Deploys' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(within(first).getByText('Partly deployed')).toBeTruthy();
    expect(within(first).getByText(/2 uploaded, 1 deleted, 1 failed/)).toBeTruthy();
    expect(within(first).getByText(/1 min ago/)).toBeTruthy();
    expect(within(first).getByText(/took 5 s/)).toBeTruthy();
    expect(within(first).getByText('Deploy on save')).toBeTruthy();
    expect(within(second).getByText('Deployed')).toBeTruthy();
    expect(within(second).getByText('You')).toBeTruthy();
    expect(within(second).queryByRole('button', { name: /failed/ })).toBeNull();

    await user.click(within(first).getByRole('button', { name: 'Show 1 failed file' }));
    expect(within(first).getByText('big.zip')).toBeTruthy();
    expect(within(first).getByText('The server is out of space, or over its quota.')).toBeTruthy();
  });

  it('says why a run failed in its row', async () => {
    renderView(
      fileSite(),
      {
        'deployFiles.history': [
          runResult({ state: 'failed', error: { code: 'timeout', message: '' } }),
        ],
      },
      { initial: 'history' },
    );
    expect(await screen.findByText(/took too long to answer/)).toBeTruthy();
  });

  it('has an empty state, a shimmer while loading and a way to try again', async () => {
    const { unmount, container } = renderView(
      fileSite(),
      {
        'deployFiles.history': () => new Promise(() => undefined),
      },
      { initial: 'history' },
    );
    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
    unmount();

    const empty = renderView(fileSite(), { 'deployFiles.history': [] }, { initial: 'history' });
    expect(await screen.findByText('No deploys yet')).toBeTruthy();
    empty.unmount();

    const failed = renderView(
      fileSite(),
      {
        'deployFiles.history': async () => {
          throw new Error('[files:siteUnknown] x');
        },
      },
      { initial: 'history' },
    );
    expect(await screen.findByText(/doesn't know this site anymore/)).toBeTruthy();
    failed.bridge.$set('deployFiles.history', []);
    await failed.user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('No deploys yet')).toBeTruthy();
  });

  it('refreshes after a run finishes', async () => {
    const { bridge, queryClient } = renderView(
      fileSite(),
      { 'deployFiles.history': [] },
      { initial: 'history' },
    );
    await screen.findByText('No deploys yet');
    bridge.$set('deployFiles.history', [runResult()]);
    await act(() =>
      queryClient.invalidateQueries({ queryKey: queryKeys.deployFilesHistory('fs-1') }),
    );
    expect(await screen.findByRole('list', { name: 'Deploys' })).toBeTruthy();
  });
});

describe('FileSiteView settings', () => {
  it('sums up the connection and opens the edit dialog', async () => {
    const onEdit = vi.fn();
    const { user } = renderView(fileSite(), {}, { initial: 'settings', onEdit });
    const card = screen.getByRole('region', { name: 'Connection' });
    expect(within(card).getByText('SFTP')).toBeTruthy();
    expect(within(card).getByText('deploy@files.example')).toBeTruthy();
    expect(within(card).getByText('Password, saved')).toBeTruthy();
    expect(within(card).getByText('C:\\Sites\\bakery\\dist')).toBeTruthy();
    expect(within(card).getByText('/var/www/site')).toBeTruthy();
    expect(within(card).getByText(/Exact, from file times/)).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: /Edit/ }));
    expect(onEdit).toHaveBeenCalled();
  });

  it('describes other logins and change detection', () => {
    const { unmount } = renderView(
      fileSite({
        connection: { kind: 'saved', sshServerId: 'srv-1' },
        capabilities: { atomicReplace: false, mtime: 'none', checkedAt: 1 },
      }),
      {},
      { initial: 'settings' },
    );
    expect(screen.getByText('Through a saved server in Remote')).toBeTruthy();
    expect(screen.getByText(/By size only/)).toBeTruthy();
    expect(screen.getByText(/can't replace a file in one step/)).toBeTruthy();
    unmount();

    const custom = fileSite().connection as Extract<FileSite['connection'], { kind: 'custom' }>;
    renderView(
      fileSite({
        protocol: 'ftps',
        connection: {
          ...custom,
          port: 990,
          authMethod: 'privateKey',
          privateKeyPath: 'C:\\k',
          hasSecret: false,
        },
        capabilities: { atomicReplace: true, mtime: 'mdtm', checkedAt: 1 },
      }),
      {},
      { initial: 'settings' },
    );
    expect(screen.getByText('deploy@files.example:990')).toBeTruthy();
    expect(screen.getByText('Key file C:\\k')).toBeTruthy();
    expect(screen.getByText(/asked file by file/)).toBeTruthy();
  });

  it('says when the connection was never tested', () => {
    renderView(fileSite({ capabilities: null }), {}, { initial: 'settings' });
    expect(screen.getByText(/Not tested yet/)).toBeTruthy();
  });

  it('turns Deploy on save on and keeps the site the call sends back', async () => {
    const { user, bridge, queryClient } = renderView(
      fileSite(),
      { 'deployFiles.setDeployOnSave': fileSite({ deployOnSave: true }) },
      { initial: 'settings' },
    );
    queryClient.setQueryData(queryKeys.deployFilesSites, [fileSite()]);
    expect(screen.getByText(/5 seconds after the last change/)).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: 'Deploy on save' }));
    expect(bridge.$fn('deployFiles.setDeployOnSave')).toHaveBeenCalledWith('fs-1', true);
    await waitFor(() =>
      expect(
        queryClient.getQueryData<FileSite[]>(queryKeys.deployFilesSites)?.[0].deployOnSave,
      ).toBe(true),
    );
  });

  it('says so when the switch could not be changed', async () => {
    const { user } = renderView(
      fileSite(),
      {
        'deployFiles.setDeployOnSave': async () => {
          throw new Error('[files:vaultLocked] x');
        },
      },
      { initial: 'settings' },
    );
    await user.click(screen.getByRole('switch', { name: 'Deploy on save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/locked/)));
  });

  it('checks the ignore lines as they are typed and saves them without the secret', async () => {
    const { user, bridge } = renderView(
      fileSite({ ignorePatterns: ['*.map'] }),
      {
        'deployFiles.validateIgnore': async (patterns: string[]) =>
          patterns.includes('[')
            ? { ok: false, line: patterns.indexOf('[') + 1, reason: 'An open [ has no closing ].' }
            : { ok: true },
        'deployFiles.update': async (_id: string, input: FileSiteInput) =>
          fileSite({ ignorePatterns: input.ignorePatterns }),
      },
      { initial: 'settings' },
    );

    const box = screen.getByRole('textbox', { name: 'Ignore lines' });
    expect((box as HTMLTextAreaElement).value).toBe('*.map');
    const save = screen.getByRole('button', { name: 'Save the ignore lines' });
    expect(save.hasAttribute('disabled')).toBe(true);

    await user.type(box, '{Enter}[[');
    expect(await screen.findByText('Line 2: An open [ has no closing ].')).toBeTruthy();
    expect(save.hasAttribute('disabled')).toBe(true);

    await user.type(box, '{Backspace}node_modules/');
    await waitFor(() => expect(screen.queryByText(/Line 2:/)).toBeNull());
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    await user.click(save);

    await waitFor(() => expect(bridge.$fn('deployFiles.update')).toHaveBeenCalled());
    const [id, input] = bridge.$fn('deployFiles.update').mock.calls[0];
    expect(id).toBe('fs-1');
    expect(input.ignorePatterns).toEqual(['*.map', 'node_modules/']);
    expect('hasSecret' in input.connection).toBe(false);
    expect('secret' in input.connection).toBe(false);
    expect(toast.success).toHaveBeenCalledWith('Saved the ignore lines.');
  });

  it('says why the ignore lines were not saved', async () => {
    const { user } = renderView(
      fileSite(),
      {
        'deployFiles.validateIgnore': { ok: true },
        'deployFiles.update': async () => {
          throw new Error('[files:invalidInput] Line 1 is too long.');
        },
      },
      { initial: 'settings' },
    );
    await user.type(screen.getByRole('textbox', { name: 'Ignore lines' }), 'dist/');
    const save = screen.getByRole('button', { name: 'Save the ignore lines' });
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    await user.click(save);
    expect(await screen.findByText('Line 1 is too long.')).toBeTruthy();
  });

  it('lists the attached projects with links to their Deploy tab', async () => {
    renderView(
      fileSite({ projectIds: ['p1', 'gone'] }),
      {
        'projects.list': [{ id: 'p1', name: 'Bakery theme' }],
      },
      { initial: 'settings' },
    );
    const link = await screen.findByRole('link', { name: 'Bakery theme' });
    expect(link.getAttribute('href')).toBe('/projects/p1?tab=deploy');
    expect(screen.getByText('A project that no longer exists')).toBeTruthy();
  });

  it('says when no project is attached', () => {
    renderView(fileSite(), {}, { initial: 'settings' });
    expect(screen.getByText(/Not attached to a project/)).toBeTruthy();
  });

  it('forgets what was deployed after a confirmation', async () => {
    const { user, bridge } = renderView(fileSite(), {}, { initial: 'settings' });
    await user.click(screen.getByRole('button', { name: 'Forget what was deployed' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Forget what was deployed to this site?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(bridge.$fn('deployFiles.forgetBase')).toHaveBeenCalledWith('fs-1'));
    expect(toast.success).toHaveBeenCalled();
  });

  it('keeps everything when the forget is declined, and says why one failed', async () => {
    const { user, bridge } = renderView(
      fileSite(),
      {
        'deployFiles.forgetBase': async () => {
          throw new Error('[files:busy] x');
        },
      },
      { initial: 'settings' },
    );
    await user.click(screen.getByRole('button', { name: 'Forget what was deployed' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(() => bridge.$fn('deployFiles.forgetBase')).toThrow();

    await user.click(screen.getByRole('button', { name: 'Forget what was deployed' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Forget' }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/still running/)),
    );
  });

  it('removes the site after a confirmation that says the server is not touched', async () => {
    const onRemoved = vi.fn();
    const { user, bridge, queryClient } = renderView(
      fileSite(),
      {},
      { initial: 'settings', onRemoved },
    );
    queryClient.setQueryData(queryKeys.deployFilesSites, [fileSite(), fileSite({ id: 'fs-2' })]);
    useDeployFilesRunStore.getState().finish(runResult());

    await user.click(screen.getByRole('button', { name: 'Remove site' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Bakery static?' });
    expect(within(dialog).getByText(/Files on the server are not touched/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Remove site' }));

    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(bridge.$fn('deployFiles.remove')).toHaveBeenCalledWith('fs-1');
    expect(
      queryClient.getQueryData<FileSite[]>(queryKeys.deployFilesSites)?.map((s) => s.id),
    ).toEqual(['fs-2']);
    expect(useDeployFilesRunStore.getState().runs['fs-1']).toBeUndefined();
  });

  it('says why the site could not be removed', async () => {
    const onRemoved = vi.fn();
    const { user } = renderView(
      fileSite(),
      {
        'deployFiles.remove': async () => {
          throw new Error('[files:busy] x');
        },
      },
      { initial: 'settings', onRemoved },
    );
    await user.click(screen.getByRole('button', { name: 'Remove site' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove site' }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onRemoved).not.toHaveBeenCalled();
  });
});

describe('FileSiteView changes', () => {
  it('opens Settings from the too-many-files notice', async () => {
    const { user } = renderView(fileSite(), {
      'deployFiles.subscribe': snapshot({ state: 'tooManyFiles', files: [] }),
      'deployFiles.changes': snapshot({ state: 'tooManyFiles', files: [] }),
    });
    await user.click(await screen.findByRole('button', { name: 'Edit the ignore lines' }));
    expect(screen.getByRole('textbox', { name: 'Ignore lines' })).toBeTruthy();
  });

  it('keeps a review across a switch of section', async () => {
    const { user } = renderView(fileSite(), {
      'deployFiles.plan': plan({ massDelete: true, changes: [] }),
      'deployFiles.history': [],
    });
    await user.click(await screen.findByRole('button', { name: /^Deploy 3 changes/ }));
    expect(await screen.findByRole('region', { name: 'Review before deploying' })).toBeTruthy();
    await user.click(within(sections()).getByRole('button', { name: /History/ }));
    await user.click(within(sections()).getByRole('button', { name: /Changes/ }));
    expect(await screen.findByRole('region', { name: 'Review before deploying' })).toBeTruthy();
  });
});
