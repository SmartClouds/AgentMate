import { encodeFilesError } from '@shared/deployFilesErrors';
import type { FileSiteInput, FilesBrowseInput, FilesBrowseResult } from '@shared/deployFilesTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { RemoteFolderBrowser } from './RemoteFolderBrowser';

/**
 * Picking the folder on the server: it opens where the field points (or where the login starts),
 * walks into folders and back up, shimmers each row while a folder loads, says what went wrong
 * in place, and hands back the folder it is showing.
 */

const site: FileSiteInput = {
  label: '',
  protocol: 'sftp',
  connection: {
    kind: 'custom',
    host: 'files.bakery.example',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    privateKeyPath: null,
    hostKeyFingerprint: 'ab'.repeat(32),
    tlsPin: null,
    tlsServername: null,
    secret: 'hunter2',
  },
  remoteRoot: '/home/deploy',
  localFolder: '',
  projectIds: [],
  deployOnSave: false,
  quietSeconds: 5,
  ignorePatterns: [],
};

const TREE: Record<string, FilesBrowseResult> = {
  '/': { path: '/', parent: null, folders: [{ name: 'home', path: '/home' }] },
  '/home': { path: '/home', parent: '/', folders: [{ name: 'deploy', path: '/home/deploy' }] },
  '/home/deploy': {
    path: '/home/deploy',
    parent: '/home',
    folders: [
      { name: 'public_html', path: '/home/deploy/public_html' },
      { name: 'logs', path: '/home/deploy/logs' },
    ],
  },
  '/home/deploy/public_html': {
    path: '/home/deploy/public_html',
    parent: '/home/deploy',
    folders: [],
  },
};

async function browse(input: FilesBrowseInput): Promise<FilesBrowseResult> {
  const found = TREE[input.path ?? '/home/deploy'];
  if (!found) throw new Error(encodeFilesError('remoteFolderMissing', 'No such folder.'));
  return found;
}

function Harness({
  initialPath = '/home/deploy',
  onPick = vi.fn(),
  siteId = null,
}: {
  initialPath?: string | null;
  onPick?: (path: string) => void;
  siteId?: string | null;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <RemoteFolderBrowser
      open={open}
      onOpenChange={setOpen}
      siteId={siteId}
      site={site}
      target="custom:deploy@files.bakery.example:22"
      initialPath={initialPath}
      onPick={onPick}
    >
      <button type="button">Browse</button>
    </RemoteFolderBrowser>
  );
}

function rows(): string[] {
  return within(screen.getByRole('list', { name: 'Folders' }))
    .getAllByRole('button')
    .map((one) => one.textContent ?? '');
}

describe('RemoteFolderBrowser', () => {
  it('opens at the folder the field names and lists its folders', async () => {
    const { user, bridge } = renderWithProviders(<Harness siteId="site-1" />, {
      bridge: { 'deployFiles.browseRemote': browse },
    });

    await user.click(screen.getByRole('button', { name: 'Browse' }));

    await waitFor(() => expect(rows()).toEqual(['public_html', 'logs']));
    expect(bridge.$fn('deployFiles.browseRemote')).toHaveBeenCalledWith({
      siteId: 'site-1',
      site,
      path: '/home/deploy',
    });
    const crumbs = screen.getByRole('navigation', { name: 'Folder path' });
    expect(within(crumbs).getByText('deploy').getAttribute('aria-current')).toBe('page');
  });

  it('shimmers a row at a time while a folder loads', async () => {
    let answer: (value: FilesBrowseResult) => void = () => undefined;
    const { user } = renderWithProviders(<Harness />, {
      bridge: {
        'deployFiles.browseRemote': () =>
          new Promise<FilesBrowseResult>((resolve) => {
            answer = resolve;
          }),
      },
    });

    await user.click(screen.getByRole('button', { name: 'Browse' }));

    const list = await screen.findByRole('list', { name: 'Folders' });
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(list.querySelectorAll('.shimmer').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled();

    answer(TREE['/home/deploy']);
    await waitFor(() => expect(rows()).toEqual(['public_html', 'logs']));
  });

  it('walks into a folder, back up a level and to any folder on the path', async () => {
    const { user } = renderWithProviders(<Harness />, {
      bridge: { 'deployFiles.browseRemote': browse },
    });
    await user.click(screen.getByRole('button', { name: 'Browse' }));

    await user.click(await screen.findByRole('button', { name: 'public_html' }));
    await waitFor(() => expect(screen.getByText('No folders in here.')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Up one level' }));
    await waitFor(() => expect(rows()).toEqual(['public_html', 'logs']));

    const crumbs = screen.getByRole('navigation', { name: 'Folder path' });
    await user.click(within(crumbs).getByRole('button', { name: 'Top folder' }));
    await waitFor(() => expect(rows()).toEqual(['home']));
    expect(screen.getByRole('button', { name: 'Up one level' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'home' }));
    await waitFor(() => expect(rows()).toEqual(['deploy']));
  });

  it('hands back the folder it shows and closes', async () => {
    const onPick = vi.fn();
    const { user } = renderWithProviders(<Harness onPick={onPick} />, {
      bridge: { 'deployFiles.browseRemote': browse },
    });
    await user.click(screen.getByRole('button', { name: 'Browse' }));
    await user.click(await screen.findByRole('button', { name: 'public_html' }));
    await waitFor(() => expect(screen.getByText('No folders in here.')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Use this folder' }));

    expect(onPick).toHaveBeenCalledWith('/home/deploy/public_html');
    expect(screen.queryByRole('list', { name: 'Folders' })).toBeNull();
  });

  it('starts where the login starts when the field is empty', async () => {
    const calls: (string | null)[] = [];
    const { user } = renderWithProviders(<Harness initialPath={null} />, {
      bridge: {
        'deployFiles.browseRemote': async (input: FilesBrowseInput) => {
          calls.push(input.path);
          return TREE['/home/deploy'];
        },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Browse' }));

    await waitFor(() => expect(rows()).toEqual(['public_html', 'logs']));
    expect(calls[0]).toBeNull();
  });

  it('says what went wrong in place and can try again or go to the start folder', async () => {
    let failing = true;
    const calls: (string | null)[] = [];
    const { user } = renderWithProviders(<Harness initialPath="/nope" />, {
      bridge: {
        'deployFiles.browseRemote': async (input: FilesBrowseInput) => {
          calls.push(input.path);
          if (failing) throw new Error(encodeFilesError('remoteFolderMissing', 'Gone.'));
          return browse(input);
        },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Browse' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/folder on the server doesn't exist/);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.length).toBe(2));

    failing = false;
    await user.click(
      within(await screen.findByRole('alert')).getByRole('button', {
        name: 'Go to the start folder',
      }),
    );
    await waitFor(() => expect(rows()).toEqual(['public_html', 'logs']));
    expect(calls.at(-1)).toBeNull();
  });

  it('closes with Escape without picking anything', async () => {
    const onPick = vi.fn();
    const { user } = renderWithProviders(<Harness onPick={onPick} />, {
      bridge: { 'deployFiles.browseRemote': browse },
    });
    await user.click(screen.getByRole('button', { name: 'Browse' }));
    await screen.findByRole('button', { name: 'public_html' });

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('list', { name: 'Folders' })).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });
});
