import { formatBytes } from '@shared/remoteProtocol';
import type { SftpConflict, SftpConflictAction } from '@shared/sftpTypes';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { plural } from '@/components/deploy/files/copy';
import { filesProblem } from '@/components/deploy/files/messages';
import { File, Folder, Monitor, Server } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ConflictDialogProps } from './contracts';

/**
 * "This file already exists" (E25): asked when a file being transferred is already at the target.
 * The copy being sent sits on the left and the one already there on the right, each with its size
 * and time and a Newer chip on the later one. Overwrite, Keep both (with the name it would get)
 * and Skip answer for this file, or for the rest of the transfer with the box ticked. Escape and
 * the X skip this one file, nothing more.
 *
 * The dialog stays up after an answer until the next snapshot clears or replaces the conflict, so
 * an answered question takes no second answer: everything is off until the id changes.
 */

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

interface Side {
  label: string;
  hint: string;
  Icon: typeof Server;
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  newer: boolean;
}

function sides(c: SftpConflict): [Side, Side] {
  const sourceNewer = c.source.mtimeMs > c.target.mtimeMs;
  const targetNewer = c.target.mtimeMs > c.source.mtimeMs;
  const sending = { hint: 'Sending', ...c.source, isDirectory: false, newer: sourceNewer };
  const there = { hint: 'Already there', ...c.target, newer: targetNewer };
  return c.direction === 'upload'
    ? [
        { ...sending, label: 'Yours', Icon: Monitor },
        { ...there, label: 'On the server', Icon: Server },
      ]
    : [
        { ...sending, label: 'On the server', Icon: Server },
        { ...there, label: 'On this computer', Icon: Monitor },
      ];
}

export function ConflictDialog({
  conflict,
  onResolve,
  onCancelBatch,
  serverName,
}: ConflictDialogProps): React.JSX.Element {
  // The last question stays drawn while the dialog fades out.
  const lastRef = useRef<SftpConflict | null>(null);
  if (conflict) lastRef.current = conflict;
  const shown = conflict ?? lastRef.current;
  const id = conflict?.conflictId ?? null;

  // The box is ticked for one question id, so a new question starts with it clear.
  const [applyFor, setApplyFor] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  const applyToAll = id !== null && applyFor === id;
  const locked = id === null || answered === id;
  const checkboxId = useId();
  const overwriteRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  function answer(action: SftpConflictAction, all: boolean): void {
    if (!conflict || locked) return;
    const forId = conflict.conflictId;
    setAnswered(forId);
    void Promise.resolve()
      .then(() => onResolve({ action, applyToAll: all }))
      .catch((error: unknown) => {
        toast.error('Could not send your answer', { description: filesProblem(error) });
        setAnswered((now) => (now === forId ? null : now));
      });
  }

  function cancelBatch(): void {
    if (!conflict || locked) return;
    const forId = conflict.conflictId;
    setAnswered(forId);
    void Promise.resolve()
      .then(() => onCancelBatch(conflict.batchId))
      .catch((error: unknown) => {
        toast.error('Could not cancel the transfer', { description: filesProblem(error) });
        setAnswered((now) => (now === forId ? null : now));
      });
  }

  const folderInTheWay = shown?.target.isDirectory ?? false;
  const remaining = shown?.remainingInBatch ?? 0;
  const [left, right] = shown ? sides(shown) : [null, null];

  return (
    <Dialog
      open={conflict !== null}
      onOpenChange={(open) => {
        if (!open) answer('skip', false);
      }}
    >
      <DialogContent
        className="max-w-xl"
        // A stray click beside the dialog is not an answer; Escape and the X are.
        onPointerDownOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (folderInTheWay ? keepRef : overwriteRef).current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>This file already exists</DialogTitle>
          <DialogDescription className="break-words">
            {serverName ? (
              <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Server className="h-3 w-3 shrink-0" />
                <span className="min-w-0 truncate">{`On ${serverName}`}</span>
              </span>
            ) : null}
            {folderInTheWay ? 'A folder named ' : null}
            <span className="font-medium text-foreground">{shown?.name}</span>
            {' is already in '}
            <span className="font-mono text-[13px] text-foreground/85">{shown?.targetDir}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {left && <CopyCard side={left} />}
            {right && <CopyCard side={right} />}
          </div>
          <p className="text-xs text-muted-foreground">
            Keep both saves the new one as{' '}
            <span className="font-mono text-foreground/85">{shown?.renameTo}</span>.
          </p>
          {remaining > 0 && (
            <div className="flex items-center gap-2.5">
              <Checkbox
                id={checkboxId}
                checked={applyToAll}
                disabled={locked}
                onCheckedChange={(v) => setApplyFor(v === true && id ? id : null)}
              />
              <label htmlFor={checkboxId} className="cursor-pointer select-none text-sm">
                {`Do the same for the rest of this transfer (${plural(remaining, 'more file')})`}
              </label>
            </div>
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 text-muted-foreground hover:text-destructive"
            disabled={locked}
            onClick={cancelBatch}
          >
            Cancel this transfer
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="soft" disabled={locked} onClick={() => answer('skip', applyToAll)}>
              Skip
            </Button>
            <Button
              ref={keepRef}
              variant="soft"
              disabled={locked}
              onClick={() => answer('rename', applyToAll)}
            >
              Keep both
            </Button>
            <SimpleTooltip
              label={
                folderInTheWay
                  ? 'A folder is there, and a file cannot replace a folder. Keep both or skip.'
                  : null
              }
              wrapTrigger
            >
              <Button
                ref={overwriteRef}
                disabled={locked || folderInTheWay}
                onClick={() => answer('overwrite', applyToAll)}
              >
                Overwrite
              </Button>
            </SimpleTooltip>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CopyCard({ side }: { side: Side }): React.JSX.Element {
  const KindIcon = side.isDirectory ? Folder : File;
  return (
    <section
      aria-label={side.label}
      className={cn(
        'space-y-2 rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-inset ring-foreground/[0.07]',
        side.newer && 'bg-primary/[0.05] ring-primary/25',
      )}
    >
      <div className="flex items-center gap-2">
        <side.Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{side.label}</h3>
        {side.newer && <Chip tone="primary">Newer</Chip>}
      </div>
      <p className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground/70">
        {side.hint}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Size</dt>
        <dd className="flex items-center gap-1.5 tabular-nums">
          <KindIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
          {side.isDirectory ? 'Folder' : formatBytes(side.size)}
        </dd>
        <dt className="text-muted-foreground">Modified</dt>
        <dd className="tabular-nums">{DATE.format(side.mtimeMs)}</dd>
      </dl>
    </section>
  );
}
