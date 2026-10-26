import type { BlueprintAttachment, BlueprintStepId } from '@runova/core';
import { blueprintFileUrl, isImageMime, isVideoMime } from '@runova/core';
import { useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink, FileText, Paperclip, Plus, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatAttachmentSize } from './attachmentKinds';

/** Matches the main process cap, so an oversized file is refused before it crosses the bridge. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Turns a dropped or pasted File into the data URL the main process expects, the
 * same trip a project icon makes. `File.path` isn't available in a sandboxed
 * renderer, so the bytes have to go over the bridge.
 */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('That file could not be read.'));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}

/** Shared by the paste and drop handlers on the step editor. */
export async function addFilesAsAttachments(
  files: File[],
  onAdd: (displayName: string, dataUrl: string) => void,
): Promise<void> {
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error(`${file.name} is too large. Attachments are limited to 25 MB.`);
      continue;
    }
    try {
      onAdd(file.name, await readFileAsDataUrl(file));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That file could not be read.');
    }
  }
}

/**
 * The files this step holds, as a strip under the editor. Files are placed in
 * the text rather than owned by the step, so this is the inventory rather than
 * the presentation: it exists to put a file back after it has been cut out of
 * the writing, to rename one, and to delete one for good.
 */
export function BlueprintAttachments({
  projectId,
  stepId,
  attachments,
  usedFileNames,
  onPick,
  onInsert,
  onRename,
  onRemove,
  busy,
}: {
  projectId: string;
  stepId: BlueprintStepId;
  attachments: BlueprintAttachment[];
  /** File names the step's markdown currently points at, so the rest can be flagged. */
  usedFileNames: Set<string>;
  onPick: (stepId: BlueprintStepId) => void;
  onInsert: (attachment: BlueprintAttachment) => void;
  onRename: (attachmentId: string, displayName: string) => void;
  onRemove: (attachment: BlueprintAttachment) => void;
  busy: boolean;
}): React.JSX.Element {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  function commitRename(): void {
    if (!renamingId) return;
    const value = renameValue.trim();
    const current = attachments.find((entry) => entry.id === renamingId);
    if (current && value && value !== current.displayName) onRename(renamingId, value);
    setRenamingId(null);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          // Keeps the caret in the editor, the same trick its own toolbar uses,
          // so a file picked here lands where the writing was left off rather
          // than at the bottom of the step.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(stepId)}
          disabled={busy}
        >
          <Paperclip /> Attach files
        </Button>
        <p className="text-xs text-muted-foreground">
          Images and video land where the caret is, so you can write above and below them. Paste or
          drop onto the editor does the same.
        </p>
      </div>

      {attachments.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {attachments.map((attachment) => {
            const used = usedFileNames.has(attachment.fileName);
            const url = blueprintFileUrl(attachment.fileName);
            return (
              <div
                key={attachment.id}
                className="group relative overflow-hidden rounded-lg border border-border bg-background/40"
              >
                <div className="flex h-20 items-center justify-center overflow-hidden bg-muted/40">
                  {isImageMime(attachment.mime) ? (
                    <img
                      src={url}
                      alt={attachment.displayName}
                      className="h-full w-full object-cover"
                    />
                  ) : isVideoMime(attachment.mime) ? (
                    // Metadata only: a strip of six files shouldn't pull six videos.
                    <video
                      src={url}
                      preload="metadata"
                      muted
                      className="h-full w-full object-cover"
                    >
                      <track kind="captions" />
                    </video>
                  ) : (
                    <FileText className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>

                <div className="space-y-0.5 px-2 py-1.5">
                  {renamingId === attachment.id ? (
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename();
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                      className="h-7 text-xs"
                    />
                  ) : (
                    <SimpleTooltip label="Click to rename">
                      <button
                        type="button"
                        className="block w-full cursor-text truncate text-left text-xs font-medium"
                        onClick={() => {
                          setRenamingId(attachment.id);
                          setRenameValue(attachment.displayName);
                        }}
                      >
                        {attachment.displayName}
                      </button>
                    </SimpleTooltip>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {formatAttachmentSize(attachment.size)}
                    {used ? '' : ' · not in the text'}
                  </p>
                </div>

                <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <SimpleTooltip
                    label={used ? 'Insert another copy at the caret' : 'Insert at the caret'}
                  >
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Insert ${attachment.displayName}`}
                      className="bg-background/80"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onInsert(attachment)}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </SimpleTooltip>
                  <SimpleTooltip label="Open outside Runova">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Open ${attachment.displayName}`}
                      className="bg-background/80"
                      onClick={() => void openExternally(projectId, attachment.id)}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  </SimpleTooltip>
                  <SimpleTooltip label="Delete the file">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${attachment.displayName}`}
                      className="bg-background/80 hover:text-destructive"
                      onClick={() => onRemove(attachment)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </SimpleTooltip>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

async function openExternally(projectId: string, attachmentId: string): Promise<void> {
  const path = await window.runova.blueprints.attachmentPath(projectId, attachmentId);
  if (path) await window.runova.shell.openPath(path);
}
