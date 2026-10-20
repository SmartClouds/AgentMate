import { filesError } from '@shared/deployFilesErrors';
import type { SftpRemoteEntry, SftpTextFile } from '@shared/sftpTypes';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import type { RemoteEditorDialogProps } from './contracts';

/**
 * A remote text file in the editor: it shimmers while it loads, says whether it is saved, saves
 * on Ctrl+S, never silently overwrites a copy someone changed on the server, and asks before
 * closing with unsaved edits. Files it cannot edit get a toast and no dialog.
 */

// The aliased Monaco stub never reports typing, so the editor is a plain text box here. The last
// `onChange` is kept so a test can report an edit the way Monaco does, outside React's events.
const monaco = vi.hoisted(() => ({ onChange: undefined as ((v: string) => void) | undefined }));
vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({
    value,
    onChange,
    language,
  }: {
    value: string;
    onChange?: (v: string) => void;
    language?: string;
  }) => {
    monaco.onChange = onChange;
    return (
      <textarea
        aria-label="Editor"
        data-language={language}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      />
    );
  },
}));
vi.mock('@/components/editor/MonacoDiffEditor', () => ({
  languageFor: (path: string) => (path.endsWith('.html') ? 'html' : 'plaintext'),
}));

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/stores/confirmStore', () => confirm);

const editorModule = await import('./RemoteEditorDialog');
const { RemoteEditorDialog } = editorModule;

const PATH = '/var/www/index.html';

function file(over: Partial<SftpTextFile> = {}): SftpTextFile {
  return {
    path: PATH,
    content: '<h1>Hi</h1>',
    size: 11,
    mtimeMs: 1_700_000_000_000,
    mode: 0o640,
    bom: false,
    ...over,
  };
}

function entry(over: Partial<SftpRemoteEntry> = {}): SftpRemoteEntry {
  return {
    name: 'index.html',
    path: PATH,
    kind: 'file',
    isDirectory: false,
    isSymlink: false,
    size: 20,
    mtimeMs: 1_700_000_100_000,
    mode: 0o640,
    owner: 'www',
    group: 'www',
    ...over,
  };
}

function renderEditor(
  bridge: Record<string, unknown>,
  over: Partial<RemoteEditorDialogProps> = {},
) {
  const props: RemoteEditorDialogProps = {
    open: true,
    sessionId: 'sess-1',
    path: PATH,
    onOpenChange: vi.fn(),
    onSaved: vi.fn(),
    ...over,
  };
  return { ...renderWithProviders(<RemoteEditorDialog {...props} />, { bridge }), props };
}

async function edit(text: string): Promise<void> {
  fireEvent.change(await screen.findByRole('textbox', { name: 'Editor' }), {
    target: { value: text },
  });
}

beforeEach(() => {
  toast.error.mockClear();
  confirm.confirmDialog.mockClear();
  confirm.confirmDialog.mockResolvedValue(true);
});

describe('RemoteEditorDialog', () => {
  it('is the default export too, for the page to load it lazily', () => {
    expect(editorModule.default).toBe(RemoteEditorDialog);
  });

  it('shimmers while the file loads, then shows it with the language of its name', async () => {
    let answer: (f: SftpTextFile) => void = () => undefined;
    const readText = vi.fn(
      () =>
        new Promise<SftpTextFile>((resolve) => {
          answer = resolve;
        }),
    );
    renderEditor({ 'sftp.readText': readText });

    expect(screen.getByRole('dialog', { name: PATH })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading the file' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Editor' })).toBeNull();
    expect(readText).toHaveBeenCalledWith('sess-1', PATH);

    answer(file());
    const editor = await screen.findByRole('textbox', { name: 'Editor' });
    expect(editor).toHaveValue('<h1>Hi</h1>');
    expect(editor).toHaveAttribute('data-language', 'html');
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('starts from the file it was given, without reading it again', async () => {
    const readText = vi.fn();
    renderEditor({ 'sftp.readText': readText }, { initialFile: file({ content: 'given' }) });
    expect(await screen.findByRole('textbox', { name: 'Editor' })).toHaveValue('given');
    expect(screen.queryByRole('status', { name: 'Loading the file' })).toBeNull();
    expect(readText).not.toHaveBeenCalled();
  });

  it('reads the file when what it was given is for another path', async () => {
    const readText = vi.fn(async () => file());
    renderEditor({ 'sftp.readText': readText }, { initialFile: file({ path: '/elsewhere' }) });
    expect(await screen.findByRole('textbox', { name: 'Editor' })).toHaveValue('<h1>Hi</h1>');
    expect(readText).toHaveBeenCalledWith('sess-1', PATH);
  });

  it('says there are unsaved changes after an edit', async () => {
    renderEditor({ 'sftp.readText': file() });
    await edit('<h1>Hello</h1>');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('saves on Ctrl+S with the base it read, then says Saved and reports the new entry', async () => {
    const writeText = vi.fn(async (_session: string, _input: unknown) => entry());
    const { props } = renderEditor({
      'sftp.readText': file({ bom: true }),
      'sftp.writeText': writeText,
    });
    await edit('<h1>Hello</h1>');

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Editor' }), {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
    });

    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith('sess-1', {
      path: PATH,
      content: '<h1>Hello</h1>',
      bom: true,
      base: { size: 11, mtimeMs: 1_700_000_000_000 },
      force: false,
    });
    expect(props.onSaved).toHaveBeenCalledWith(entry());

    // The next save goes from what the server said after this one, not from the first read.
    await edit('<h1>Hello again</h1>');
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls[1]![1]).toMatchObject({
      base: { size: 20, mtimeMs: 1_700_000_100_000 },
      force: false,
    });
  });

  it('saves the last keystroke even when Ctrl+S lands before React renders it', async () => {
    const writeText = vi.fn(async (_session: string, _input: unknown) => entry());
    renderEditor({ 'sftp.readText': file(), 'sftp.writeText': writeText });
    const editor = await screen.findByRole('textbox', { name: 'Editor' });

    // One batch: the edit and the shortcut reach the dialog before any re-render.
    act(() => {
      monaco.onChange?.('<h1>Late</h1>');
      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true }),
      );
    });

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![1]).toMatchObject({ content: '<h1>Late</h1>' });
  });

  it('does nothing on Ctrl+S with nothing to save', async () => {
    const writeText = vi.fn();
    renderEditor({ 'sftp.readText': file(), 'sftp.writeText': writeText });
    const editor = await screen.findByRole('textbox', { name: 'Editor' });
    fireEvent.keyDown(editor, { key: 's', code: 'KeyS', ctrlKey: true });
    expect(screen.getByRole('button', { name: /^Save/ })).toBeDisabled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('offers Overwrite when the file changed on the server, and sends force', async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(filesError('changedOnServer', 'changed'))
      .mockResolvedValue(entry());
    const { user } = renderEditor({ 'sftp.readText': file(), 'sftp.writeText': writeText });
    await edit('mine');
    await user.click(screen.getByRole('button', { name: /^Save/ }));

    expect(
      await screen.findByText(/changed on the server since you opened it/),
    ).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Overwrite' }));
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(writeText).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({ force: true }));
    expect(screen.queryByText(/changed on the server since you opened it/)).toBeNull();
  });

  it('reloads the server copy from the notice, dropping the edits', async () => {
    const readText = vi
      .fn()
      .mockResolvedValueOnce(file())
      .mockResolvedValueOnce(file({ content: 'theirs', size: 6 }));
    const { user } = renderEditor({
      'sftp.readText': readText,
      'sftp.writeText': vi.fn().mockRejectedValue(filesError('changedOnServer', 'changed')),
    });
    await edit('mine');
    await user.click(screen.getByRole('button', { name: /^Save/ }));
    await user.click(await screen.findByRole('button', { name: 'Reload' }));

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Editor' })).toHaveValue('theirs'),
    );
    expect(readText).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('keeps editing from the notice without touching the file', async () => {
    const { user } = renderEditor({
      'sftp.readText': file(),
      'sftp.writeText': vi.fn().mockRejectedValue(filesError('changedOnServer', 'changed')),
    });
    await edit('mine');
    await user.click(screen.getByRole('button', { name: /^Save/ }));
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('button', { name: 'Overwrite' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Editor' })).toHaveValue('mine');
  });

  it('shows a toast for any other save failure and keeps the edits', async () => {
    const { user } = renderEditor({
      'sftp.readText': file(),
      'sftp.writeText': vi.fn().mockRejectedValue(filesError('diskFull', 'no space')),
    });
    await edit('mine');
    await user.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0]![1]).toMatchObject({
      description: 'The server is out of space, or over its quota.',
    });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('asks before closing with unsaved changes, and stays open when told no', async () => {
    confirm.confirmDialog.mockResolvedValueOnce(false);
    const { user, props } = renderEditor({ 'sftp.readText': file() });
    await edit('mine');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(confirm.confirmDialog).toHaveBeenCalledTimes(1);
    expect(props.onOpenChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
  });

  it('asks before closing on Escape with unsaved changes', async () => {
    const { user, props } = renderEditor({ 'sftp.readText': file() });
    await edit('mine');
    await user.keyboard('{Escape}');
    expect(confirm.confirmDialog).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
  });

  it('closes without asking when nothing changed', async () => {
    const { user, props } = renderEditor({ 'sftp.readText': file() });
    await screen.findByRole('textbox', { name: 'Editor' });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(confirm.confirmDialog).not.toHaveBeenCalled();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    ['tooLarge', 'is too large to edit here'],
    ['notText', "isn't a text file"],
  ] as const)('closes with a toast for a file that is %s', async (code, words) => {
    const { props } = renderEditor({
      'sftp.readText': vi.fn().mockRejectedValue(filesError(code, 'nope')),
    });
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining(words), expect.anything());
  });

  it('shows another load failure in place, with a way to try again', async () => {
    const readText = vi
      .fn()
      .mockRejectedValueOnce(filesError('timeout', 'slow'))
      .mockResolvedValueOnce(file());
    const { user, props } = renderEditor({ 'sftp.readText': readText });
    expect(
      await screen.findByText('The server took too long to answer. Try again in a moment.'),
    ).toBeInTheDocument();
    expect(props.onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('textbox', { name: 'Editor' })).toHaveValue('<h1>Hi</h1>');
  });

  it('reads nothing while closed', () => {
    const readText = vi.fn();
    renderEditor({ 'sftp.readText': readText }, { open: false, path: null });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readText).not.toHaveBeenCalled();
  });
});
