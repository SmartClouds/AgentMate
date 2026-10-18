import type { Project } from '@agentmat/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFilesRunEvents } from '@/components/deploy/files/hooks';
import {
  fileSite,
  pending,
  plan,
  planChange,
  runResult,
  snapshot,
} from '@/components/deploy/files/testing/fixtures';
import { queryKeys } from '@/lib/queryKeys';
import { useDeployFilesRunStore } from '@/stores/deployFilesRunStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ProjectDeploySection } from './ProjectDeploySection';

/**
 * A project's Deploy tab (E23): the FTP and SFTP sites attached to it, each with its changes and
 * its own Deploy button, and the way to add one with the project already filled in.
 */

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock('sonner', () => ({ toast }));

const siteForm = vi.hoisted(() => ({
  saved: null as unknown,
  last: null as null | { site: unknown; initialProjectId?: string | null; open: boolean },
}));
vi.mock('@/components/deploy/files/SiteFormDialog', () => ({
  SiteFormDialog: (props: {
    open: boolean;
    site: { label: string } | null;
    initialProjectId?: string | null;
    onOpenChange: (open: boolean) => void;
    onSaved: (site: unknown) => void;
  }) => {
    siteForm.last = {
      site: props.site,
      initialProjectId: props.initialProjectId,
      open: props.open,
    };
    if (!props.open) return null;
    return (
      <div role="dialog" aria-label={props.site ? `Edit ${props.site.label}` : 'Add a site'}>
        <button
          type="button"
          onClick={() => {
            props.onSaved(siteForm.saved);
            props.onOpenChange(false);
          }}
        >
          Save the site
        </button>
      </div>
    );
  },
}));

const PROJECT = { id: 'p1', name: 'Apollo', folderPath: 'C:\\code\\apollo' } as Project;

function Probe(): React.JSX.Element {
  const location = useLocation();
  return <span data-testid="path">{`${location.pathname}${location.search}`}</span>;
}

/** The app shell's listener for FTP and SFTP runs, which the tab itself does not mount. */
function FilesRunEvents(): null {
  useFilesRunEvents();
  return null;
}

function renderSection(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <FilesRunEvents />
      <ProjectDeploySection project={PROJECT} />
      <Probe />
    </>,
    {
      route: '/projects/p1?tab=deploy',
      bridge: {
        'deployFiles.subscribe': snapshot(),
        'deployFiles.changes': snapshot(),
        ...bridge,
      },
    },
  );
}

beforeEach(() => {
  useDeployFilesRunStore.setState(useDeployFilesRunStore.getInitialState(), true);
  for (const fn of Object.values(toast)) fn.mockClear();
  siteForm.last = null;
});

describe('ProjectDeploySection', () => {
  it('shimmers while the sites load', () => {
    const { container } = renderSection({ 'deployFiles.list': () => new Promise(() => undefined) });
    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('offers to add a site with this project filled in when none is attached', async () => {
    siteForm.saved = fileSite({ projectIds: ['p1'] });
    const { user, bridge } = renderSection({
      'deployFiles.list': [fileSite({ id: 'fs-9', label: 'Elsewhere', projectIds: ['p2'] })],
    });

    expect(await screen.findByText('No FTP or SFTP site yet')).toBeTruthy();
    expect(screen.queryByText('Elsewhere')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Add an FTP or SFTP site/ }));
    expect(siteForm.last).toMatchObject({ site: null, initialProjectId: 'p1', open: true });

    bridge.$set('deployFiles.list', async () => [siteForm.saved]);
    await user.click(screen.getByRole('button', { name: 'Save the site' }));
    expect(await screen.findByRole('heading', { name: 'Bakery static' })).toBeTruthy();
  });

  it('shows each attached site with its address, changes and a way into Deploy', async () => {
    renderSection({
      'deployFiles.list': [
        fileSite({ projectIds: ['p1'] }),
        fileSite({ id: 'fs-2', label: 'Mirror', protocol: 'ftp', projectIds: ['p1', 'p3'] }),
      ],
    });

    const card = await screen.findByRole('region', { name: 'Bakery static' });
    expect(within(card).getByText('deploy@files.example:/var/www/site')).toBeTruthy();
    expect(await within(card).findByText('3 changes, 6.00 KB since the last deploy')).toBeTruthy();
    expect(within(card).getByRole('button', { name: /^Deploy 3 changes/ })).toBeTruthy();
    const open = within(card).getByRole('link', { name: /Open in Deploy/ });
    expect(open.getAttribute('href')).toBe('/deploy?files=fs-1');
    const mirror = screen.getByRole('region', { name: 'Mirror' });
    expect(within(mirror).getByText('Not encrypted')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add another site/ })).toBeTruthy();
  });

  it('keeps the file list folded until asked', async () => {
    const { user } = renderSection({ 'deployFiles.list': [fileSite({ projectIds: ['p1'] })] });
    const toggle = await screen.findByRole('button', { name: 'Show the files (3)' });
    expect(screen.queryByRole('list', { name: 'Changed files' })).toBeNull();
    await user.click(toggle);
    expect(screen.getByRole('list', { name: 'Changed files' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Hide the files' }));
    expect(screen.queryByRole('list', { name: 'Changed files' })).toBeNull();
  });

  it('deploys from the card and shows the outcome there', async () => {
    const { user, bridge } = renderSection({
      'deployFiles.list': [fileSite({ projectIds: ['p1'] })],
      'deployFiles.subscribe': snapshot({ files: [pending('index.html')] }),
      'deployFiles.changes': snapshot({ files: [pending('index.html')] }),
      'deployFiles.plan': plan({ changes: [planChange('index.html')] }),
      'deployFiles.deploy': runResult({ uploaded: 1, deleted: 0 }),
    });
    await user.click(await screen.findByRole('button', { name: /^Deploy 1 change/ }));
    await waitFor(() => expect(bridge.$fn('deployFiles.deploy')).toHaveBeenCalled());
    expect(await screen.findByRole('region', { name: 'Last deploy' })).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Deployed Bakery static: 1 uploaded.');
  });

  it('explains a site that needs review and checks the server from there', async () => {
    const { user, bridge } = renderSection({
      'deployFiles.list': [
        fileSite({
          projectIds: ['p1'],
          needsReview: { reason: 'massDelete', message: '40 files would go.', at: 1 },
        }),
      ],
      'deployFiles.plan': () => new Promise(() => undefined),
    });
    const notice = await screen.findByRole('status', { name: 'Deploy on save stopped' });
    expect(within(notice).getByText('40 files would go.')).toBeTruthy();
    await screen.findByText('3 changes, 6.00 KB since the last deploy');
    await user.click(within(notice).getByRole('button', { name: 'Review the changes' }));
    await waitFor(() => expect(bridge.$fn('deployFiles.plan')).toHaveBeenCalled());
  });

  it('edits a site whose folder is gone, and opens its Settings in Deploy', async () => {
    siteForm.saved = fileSite({ projectIds: ['p1'] });
    const { user } = renderSection({
      'deployFiles.list': [fileSite({ projectIds: ['p1'] })],
      'deployFiles.subscribe': snapshot({ state: 'folderMissing', files: [] }),
      'deployFiles.changes': snapshot({ state: 'folderMissing', files: [] }),
    });
    await user.click(await screen.findByRole('button', { name: 'Pick the folder again' }));
    expect(screen.getByRole('dialog', { name: 'Edit Bakery static' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save the site' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('goes to the site settings in Deploy for the ignore lines', async () => {
    const { user } = renderSection({
      'deployFiles.list': [fileSite({ projectIds: ['p1'] })],
      'deployFiles.subscribe': snapshot({ state: 'tooManyFiles', files: [] }),
      'deployFiles.changes': snapshot({ state: 'tooManyFiles', files: [] }),
    });
    await user.click(await screen.findByRole('button', { name: 'Edit the ignore lines' }));
    expect(screen.getByTestId('path').textContent).toBe('/deploy?files=fs-1&view=settings');
  });

  it('says why the sites did not load and tries again', async () => {
    const { user, bridge } = renderSection({
      'deployFiles.list': async () => {
        throw new Error('[files:vaultLocked] locked');
      },
    });
    expect(await screen.findByText(/locked with a passkey/)).toBeTruthy();
    bridge.$set('deployFiles.list', async () => []);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('No FTP or SFTP site yet')).toBeTruthy();
  });

  it('offers to edit the site after a certificate failure', async () => {
    const { user } = renderSection({
      'deployFiles.list': [fileSite({ projectIds: ['p1'], protocol: 'ftps' })],
      'deployFiles.plan': async () => {
        throw new Error('[files:tlsUntrusted] self-signed');
      },
    });
    await user.click(await screen.findByRole('button', { name: /^Deploy 3 changes/ }));
    await user.click(await screen.findByRole('button', { name: 'Edit the site' }));
    expect(screen.getByRole('dialog', { name: 'Edit Bakery static' })).toBeTruthy();
  });

  it('checks the server once for a needs-review notice, even after the tab is opened again', async () => {
    const bridge = {
      'deployFiles.list': [
        fileSite({
          projectIds: ['p1'],
          needsReview: { reason: 'massDelete' as const, message: '40 files would go.', at: 1 },
        }),
      ],
      'deployFiles.plan': plan({ massDelete: true, changes: [] }),
    };
    const first = renderSection(bridge);
    const notice = await first.findByRole('status', { name: 'Deploy on save stopped' });
    await first.findByText('3 changes, 6.00 KB since the last deploy');
    await first.user.click(within(notice).getByRole('button', { name: 'Review the changes' }));
    await first.user.click(await first.findByRole('button', { name: 'Back' }));
    first.unmount();

    const again = renderSection(bridge);
    await again.findByText('3 changes, 6.00 KB since the last deploy');
    await act(async () => undefined);
    expect(again.queryByRole('region', { name: 'Review before deploying' })).toBeNull();
    expect(() => again.bridge.$fn('deployFiles.plan')).toThrow();
  });

  it('picks up a run that finishes while the tab is open', async () => {
    const { bridge, queryClient } = renderSection({
      'deployFiles.list': [fileSite({ projectIds: ['p1'] })],
    });
    await screen.findByRole('region', { name: 'Bakery static' });
    queryClient.setQueryData(queryKeys.deployFilesSites, [fileSite({ projectIds: ['p1'] })]);
    act(() => bridge.$emit('deployFiles.onRunFinished', runResult({ trigger: 'deployOnSave' })));
    expect(await screen.findByRole('region', { name: 'Last deploy' })).toBeTruthy();
  });
});
