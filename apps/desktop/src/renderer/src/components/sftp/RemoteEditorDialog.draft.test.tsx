import type { SftpRemoteEntry, SftpTextFile } from '@shared/sftpTypes';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { editorDraftKey, useSftpEditorDraftStore } from '@/stores/sftpEditorDraftStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import type { RemoteEditorDialogProps } from './contracts';

/**
 * Unsaved edits outlive the editor's own unmount. The docked file manager drops its dialogs
 * while its tab is hidden, and the shortcut that hides the drawer is not stopped by a dialog,
 * so a draft kept only in the dialog would be lost without the "Discard your changes?" question.
 */

vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea aria-label="Editor" value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));
vi.mock('@/components/editor/MonacoDiffEditor', () => ({ languageFor: () => 'plaintext' }));

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/stores/confirmStore', () => confirm);

const { RemoteEditorDialog } = await import('./RemoteEditorDialog');

const PATH = '/var/www/index.html';
const KEY = editorDraftKey('srv-1', PATH);

const FILE: SftpTextFile = {
  path: PATH,
  content: '<h1>Hi</h1>',
  size: 11,
  mtimeMs: 1_700_000_000_000,
  mode: 0o640,
  bom: false,
};

const SAVED: SftpRemoteEntry = {
  name: 'index.html',
  path: PATH,
  kind: 'file',
  isDirectory: false,
  isSymlink: false,
  size: 4,
  mtimeMs: 1_700_000_100_000,
  mode: 0o640,
  owner: 'www',
  group: 'www',
};

function renderEditor(
  bridge: Record<string, unknown>,
  over: Partial<RemoteEditorDialogProps> = {},
) {
  const props: RemoteEditorDialogProps = {
    open: true,
    sessionId: 'sess-1',
    serverId: 'srv-1',
    path: PATH,
    onOpenChange: vi.fn(),
    ...over,
  };
  return { ...renderWithProviders(<RemoteEditorDialog {...props} />, { bridge }), props };
}

async function edit(text: string): Promise<void> {
  fireEvent.change(await screen.findByRole('textbox', { name: 'Editor' }), {
    target: { value: text },
  });
}

const draft = () => useSftpEditorDraftStore.getState().drafts[KEY];

beforeEach(() => {
  useSftpEditorDraftStore.setState({ drafts: {} });
  confirm.confirmDialog.mockClear();
  confirm.confirmDialog.mockResolvedValue(true);
});

describe('RemoteEditorDialog, the unsaved draft', () => {
  it('comes back after an unmount, still unsaved, from the file it was read as', async () => {
    const readText = vi.fn(async () => FILE);
    const first = renderEditor({ 'sftp.readText': readText });
    await edit('mine');
    expect(draft()).toEqual({ content: 'mine', base: FILE });
    first.unmount();

    const writeText = vi.fn(async () => SAVED);
    renderEditor({ 'sftp.readText': readText, 'sftp.writeText': writeText });

    expect(await screen.findByRole('textbox', { name: 'Editor' })).toHaveValue('mine');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    // No second read: that would move the base and hide a change made on the server meanwhile.
    expect(readText).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith('sess-1', {
      path: PATH,
      content: 'mine',
      bom: false,
      base: { size: 11, mtimeMs: 1_700_000_000_000 },
      force: false,
    });
    expect(draft()).toBeUndefined();
  });

  it('goes when the user discards it on closing', async () => {
    const { user, props } = renderEditor({ 'sftp.readText': FILE });
    await edit('mine');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
    expect(draft()).toBeUndefined();
  });

  it('stays when the user keeps editing instead', async () => {
    confirm.confirmDialog.mockResolvedValueOnce(false);
    const { user } = renderEditor({ 'sftp.readText': FILE });
    await edit('mine');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(confirm.confirmDialog).toHaveBeenCalledTimes(1));
    expect(draft()?.content).toBe('mine');
  });

  it('goes when the edit is typed back to what the file says', async () => {
    renderEditor({ 'sftp.readText': FILE });
    await edit('mine');
    await edit(FILE.content);
    expect(draft()).toBeUndefined();
  });

  it('belongs to one server and path', async () => {
    useSftpEditorDraftStore.getState().setDraft(editorDraftKey('srv-2', PATH), {
      content: 'theirs',
      base: FILE,
    });
    renderEditor({ 'sftp.readText': FILE });
    expect(await screen.findByRole('textbox', { name: 'Editor' })).toHaveValue(FILE.content);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('is not kept for an editor that names no server', async () => {
    const first = renderEditor({ 'sftp.readText': FILE }, { serverId: undefined });
    await edit('mine');
    expect(useSftpEditorDraftStore.getState().drafts).toEqual({});
    first.unmount();
    renderEditor({ 'sftp.readText': FILE }, { serverId: undefined });
    expect(await screen.findByRole('textbox', { name: 'Editor' })).toHaveValue(FILE.content);
  });
});
