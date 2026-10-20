import type { SshSavedServer } from '@shared/apiTypes';
import type {
  SftpListing,
  SftpRemoteEntry,
  SftpSessionInfo,
  SftpTextFile,
} from '@shared/sftpTypes';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { editorDraftKey, useSftpEditorDraftStore } from '@/stores/sftpEditorDraftStore';
import { resetSftpStore, useSftpStore } from '@/stores/sftpStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { SshFilesView } from './SshFilesView';

/**
 * The editor of a docked file manager while its tab is hidden (E25 F6). The dock draws no
 * dialog then, so the editor unmounts; the unsaved edits must be there when the tab comes back.
 */

vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea aria-label="Editor" value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));
vi.mock('@/components/editor/MonacoDiffEditor', () => ({ languageFor: () => 'plaintext' }));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
  Toaster: () => null,
}));

const PATH = '/home/deploy/index.html';

const SERVER: SshSavedServer = {
  id: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 2222,
  username: 'deploy',
  authMethod: 'password',
  hasSecret: true,
  createdAt: 0,
  lastConnectedAt: null,
};

const SESSION: SftpSessionInfo = {
  sessionId: 'sess-1',
  serverId: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 2222,
  username: 'deploy',
  home: '/home/deploy',
};

const ENTRY: SftpRemoteEntry = {
  name: 'index.html',
  path: PATH,
  kind: 'file',
  isDirectory: false,
  isSymlink: false,
  size: 11,
  mtimeMs: 1_700_000_000_000,
  mode: 0o644,
  owner: 'deploy',
  group: 'deploy',
};

const TEXT: SftpTextFile = {
  path: PATH,
  content: '<h1>Hi</h1>',
  size: 11,
  mtimeMs: 1_700_000_000_000,
  mode: 0o644,
  bom: false,
};

function Harness(): React.JSX.Element {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setShown((value) => !value)}>
        Switch tab
      </button>
      <SshFilesView serverId="srv-1" variant="dock" trackVisibility={shown} />
    </>
  );
}

beforeEach(() => {
  resetSftpStore();
  useSftpEditorDraftStore.setState({ drafts: {} });
});

describe('SshFilesView in the dock, the editor', () => {
  it('keeps unsaved edits while the tab is hidden, and a save clears them', async () => {
    const writeText = vi.fn(async () => ({ ...ENTRY, size: 4, mtimeMs: 1_700_000_100_000 }));
    renderWithProviders(<Harness />, {
      bridge: {
        'ssh.listServers': [SERVER],
        'sftp.open': SESSION,
        'sftp.queue': { sessionId: 'sess-1', batches: [], conflict: null, pendingConflicts: 0 },
        'sftp.list': async (_s: string, path: string): Promise<SftpListing<SftpRemoteEntry>> => ({
          path,
          parent: '/home',
          entries: [ENTRY],
        }),
        'sftp.localPlaces': [{ id: 'home', label: 'Home', path: 'C:\\Users\\me', kind: 'home' }],
        'sftp.localList': async (path: string) => ({ path, parent: null, entries: [] }),
        'sftp.readText': TEXT,
        'sftp.writeText': writeText,
      },
    });
    await screen.findByRole('grid', { name: 'Files on prod' });
    await act(() => useSftpStore.getState().openEditor('srv-1', PATH));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Editor' }), {
      target: { value: 'mine' },
    });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    // Hidden the way Ctrl+` hides the drawer, past the modal: the editor is gone with the rest
    // of the dock's dialogs, but not the edits.
    fireEvent.click(screen.getByText('Switch tab'));
    expect(screen.queryByRole('textbox', { name: 'Editor' })).toBeNull();

    fireEvent.click(screen.getByText('Switch tab'));
    expect(await screen.findByRole('textbox', { name: 'Editor' })).toHaveValue('mine');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ content: 'mine', base: { size: 11, mtimeMs: 1_700_000_000_000 } }),
    );
    expect(
      useSftpEditorDraftStore.getState().drafts[editorDraftKey('srv-1', PATH)],
    ).toBeUndefined();
  });
});
