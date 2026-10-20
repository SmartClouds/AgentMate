import { filesErrorCode } from '@shared/deployFilesErrors';
import type { SftpTextFile } from '@shared/sftpTypes';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { filesProblem } from '@/components/deploy/files/messages';
import { languageFor } from '@/components/editor/MonacoDiffEditor';
import { MonacoEditor } from '@/components/editor/MonacoEditor';
import { FileText, Save, Spinner } from '@/components/icons';
import { Chip, Notice, Problem } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { sftpBridge } from '@/lib/sftp/bridge';
import { editRefusal } from '@/lib/sftp/messages';
import { isMacPlatform } from '@/lib/shortcuts';
import { confirmDialog } from '@/stores/confirmStore';
import { editorDraftKey, useSftpEditorDraftStore } from '@/stores/sftpEditorDraftStore';
import type { RemoteEditorDialogProps } from './contracts';

/**
 * A remote text file in Monaco (E25), in a dialog that fills the window but for a 16 px inset.
 * The page loads this file lazily, so Monaco only arrives once someone edits a file.
 *
 * The file is read when the dialog opens. A save sends the size and time it was read with, and
 * the server refuses it when the file changed there since (`changedOnServer`); a notice then
 * offers to overwrite it anyway, reload the server's copy, or keep editing. Files too large or
 * not text never open: a toast says why and the dialog closes itself.
 */

type Load =
  | { status: 'loading' }
  | { status: 'ready'; file: SftpTextFile }
  | { status: 'error'; error: unknown };

const SKELETON_WIDTHS = [62, 48, 85, 40, 73, 55, 90, 35, 68, 44, 80, 52];

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

export function RemoteEditorDialog({
  open,
  sessionId,
  serverId,
  path,
  initialFile,
  onOpenChange,
  onSaved,
}: RemoteEditorDialogProps): React.JSX.Element {
  const active = open && path !== null;
  // The X and Escape go through the body, which knows whether there are unsaved edits.
  const requestCloseRef = useRef<() => void>(() => onOpenChange(false));
  return (
    <Dialog
      open={active}
      onOpenChange={(next) => {
        if (!next) requestCloseRef.current();
      }}
    >
      {active && (
        <EditorBody
          // A new file starts from nothing: no draft, no notice.
          key={`${sessionId}\n${path}`}
          sessionId={sessionId}
          draftKey={serverId ? editorDraftKey(serverId, path) : null}
          path={path}
          initialFile={initialFile?.path === path ? initialFile : undefined}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
          requestCloseRef={requestCloseRef}
        />
      )}
    </Dialog>
  );
}

export default RemoteEditorDialog;

function EditorBody({
  sessionId,
  draftKey,
  path,
  initialFile,
  onOpenChange,
  onSaved,
  requestCloseRef,
}: Omit<RemoteEditorDialogProps, 'open' | 'path' | 'serverId'> & {
  /** Where the unsaved draft is kept across an unmount; null keeps it in here only. */
  draftKey: string | null;
  path: string;
  requestCloseRef: React.MutableRefObject<() => void>;
}): React.JSX.Element {
  // A draft left unsaved when this editor last unmounted (its dock tab was hidden, say) comes
  // back with the file it was read as, so the save still checks for a change on the server.
  const [kept] = useState(() =>
    draftKey ? useSftpEditorDraftStore.getState().drafts[draftKey] : undefined,
  );
  const [load, setLoad] = useState<Load>(() =>
    kept
      ? { status: 'ready', file: kept.base }
      : initialFile
        ? { status: 'ready', file: initialFile }
        : { status: 'loading' },
  );
  const [draft, setDraftState] = useState<string | null>(kept?.content ?? null);
  // Monaco reports edits outside React, so a Ctrl+S can land before the render that holds the
  // last keystrokes. Saving reads this ref, which every edit updates at once.
  const draftRef = useRef<string | null>(kept?.content ?? null);
  const setDraft = useCallback((next: string | null | ((now: string | null) => string | null)) => {
    const value = typeof next === 'function' ? next(draftRef.current) : next;
    draftRef.current = value;
    setDraftState(value);
  }, []);
  const [saving, setSaving] = useState(false);
  // Monaco created in the same commit that opens the dialog takes focus but never receives typed
  // text (its EditContext input stays dead), so it waits until the dialog has painted.
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPainted(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);
  const [changedOnServer, setChangedOnServer] = useState(false);
  const closingRef = useRef(false);
  const name = baseName(path);
  const file = load.status === 'ready' ? load.file : null;
  const dirty = file !== null && draft !== null && draft !== file.content;

  // Kept while unsaved, gone once saved, reloaded or typed back to what the file says.
  useEffect(() => {
    if (!draftKey) return;
    const drafts = useSftpEditorDraftStore.getState();
    if (dirty && file && draft !== null) drafts.setDraft(draftKey, { content: draft, base: file });
    else drafts.clearDraft(draftKey);
  }, [draftKey, dirty, draft, file]);

  const read = useCallback(async (): Promise<void> => {
    setLoad({ status: 'loading' });
    try {
      const next = await sftpBridge().readText(sessionId, path);
      setLoad({ status: 'ready', file: next });
      setDraft(null);
      setChangedOnServer(false);
    } catch (error) {
      const code = filesErrorCode(error);
      const refusal = code ? editRefusal(name, code) : null;
      if (refusal) {
        // A reload can meet what the store's first read would have (the file grew, say).
        toast.error(refusal.title, { description: refusal.description });
        onOpenChange(false);
        return;
      }
      setLoad({ status: 'error', error });
    }
  }, [sessionId, path, name, onOpenChange, setDraft]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per file; the key remounts for another
  useEffect(() => {
    // The page already read it (or a kept draft has it); only Reload and Try again read again.
    if (!initialFile && !kept) void read();
  }, []);

  async function save(force: boolean): Promise<void> {
    const content = draftRef.current;
    if (!file || content === null || saving) return;
    if (content === file.content && !force) return;
    setSaving(true);
    try {
      const saved = await sftpBridge().writeText(sessionId, {
        path,
        content,
        bom: file.bom,
        base: { size: file.size, mtimeMs: file.mtimeMs },
        force,
      });
      setLoad({
        status: 'ready',
        file: { ...file, content, size: saved.size, mtimeMs: saved.mtimeMs, mode: saved.mode },
      });
      // Typing during the save keeps those keystrokes as the new draft.
      setDraft((now) => (now === content ? null : now));
      setChangedOnServer(false);
      onSaved?.(saved);
    } catch (error) {
      if (filesErrorCode(error) === 'changedOnServer') {
        setChangedOnServer(true);
      } else {
        toast.error(`Could not save ${name}`, { description: filesProblem(error) });
      }
    } finally {
      setSaving(false);
    }
  }

  async function requestClose(): Promise<void> {
    if (closingRef.current) return;
    if (dirty) {
      closingRef.current = true;
      const discard = await confirmDialog({
        title: 'Discard your changes?',
        description: `Your edits to ${name} are not saved on the server yet.`,
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        variant: 'destructive',
      });
      closingRef.current = false;
      if (!discard) return;
      if (draftKey) useSftpEditorDraftStore.getState().clearDraft(draftKey);
    }
    onOpenChange(false);
  }

  requestCloseRef.current = () => void requestClose();

  const shortcut = isMacPlatform() ? 'Cmd+S' : 'Ctrl+S';

  return (
    <DialogContent
      className="inset-4 w-auto max-w-none max-h-none translate-x-0 translate-y-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
      onKeyDownCapture={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.shiftKey &&
          !event.altKey &&
          (event.code === 'KeyS' || event.key.toLowerCase() === 's')
        ) {
          event.preventDefault();
          event.stopPropagation();
          void save(false);
        }
      }}
      onEscapeKeyDown={(event) => {
        // Escape in Monaco first closes its own find or suggest box.
        const inEditor = (event.target as Element | null)?.closest?.('.monaco-editor');
        if (inEditor?.querySelector('.find-widget.visible, .suggest-widget.visible')) {
          event.preventDefault();
          return;
        }
      }}
      onInteractOutside={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      <div className="flex h-12 min-w-0 items-center gap-2.5 py-2 pl-4 pr-14 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <DialogTitle className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium leading-normal [direction:rtl] text-left">
          <bdi>{path}</bdi>
        </DialogTitle>
        <DialogDescription className="sr-only">
          Editing a file on the server. Save sends it back; closing with unsaved changes asks first.
        </DialogDescription>
        {file &&
          (dirty ? (
            <Chip tone="warning" dot>
              Unsaved changes
            </Chip>
          ) : (
            <Chip tone="success">Saved</Chip>
          ))}
        <SimpleTooltip label={`Save to the server (${shortcut})`}>
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void save(false)}
            className="shrink-0"
          >
            {saving ? <Spinner className="motion-safe:animate-spin" /> : <Save />}
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </SimpleTooltip>
      </div>

      <div>
        {changedOnServer && (
          <Notice
            tone="warning"
            size="sm"
            role="alert"
            className="m-3 mb-0 items-center"
            action={
              <>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={saving}
                  onClick={() => void save(true)}
                >
                  Overwrite
                </Button>
                <Button size="sm" variant="soft" disabled={saving} onClick={() => void read()}>
                  Reload
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setChangedOnServer(false)}
                >
                  Keep editing
                </Button>
              </>
            }
          >
            <p className="font-medium">{`${name} changed on the server since you opened it.`}</p>
            <p className="text-muted-foreground">
              Overwrite it with your version, or reload the server's copy and lose your edits.
            </p>
          </Notice>
        )}
      </div>

      <div className="relative min-h-0">
        {load.status === 'loading' || (load.status === 'ready' && !painted) ? (
          <div role="status" aria-label="Loading the file" className="space-y-2 p-4">
            {SKELETON_WIDTHS.map((width, i) => (
              <Skeleton key={i} className="h-3.5 rounded" style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : load.status === 'error' ? (
          <div className="p-4">
            <Problem message={filesProblem(load.error)} onRetry={() => void read()} />
          </div>
        ) : (
          <MonacoEditor
            value={draft ?? load.file.content}
            onChange={(value) => setDraft(value)}
            language={languageFor(path)}
            className="absolute inset-0 min-h-0 rounded-none border-0"
          />
        )}
      </div>
    </DialogContent>
  );
}
