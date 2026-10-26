import type {
  BlueprintAttachment,
  BlueprintPreset,
  BlueprintSection,
  BlueprintStepId,
} from '@runova/core';
import { blueprintFileMarkdown, blueprintStep, referencedAttachmentNames } from '@runova/core';
import type { BlueprintAgentFileTarget } from '@shared/apiTypes';
import { useEffect, useRef, useState } from 'react';
import type { MarkdownEditorHandle } from '@/components/editor/MarkdownEditor';
import { MarkdownEditor } from '@/components/editor/MarkdownEditor';
import { History } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { addFilesAsAttachments, BlueprintAttachments } from './BlueprintAttachments';
import { BlueprintPresetChips } from './BlueprintPresetChips';

/**
 * One step of the wizard, written as markdown so a screenshot can sit between
 * the sentence that introduces it and the one that follows. The text is kept
 * locally and saved on blur rather than on every keystroke: each save writes a
 * revision, and a revision per character would make the history useless.
 */
export function BlueprintStepEditor({
  projectId,
  stepId,
  section,
  presets,
  agentFile,
  onSave,
  onToggleInclude,
  onPickAttachments,
  onAddAttachment,
  onRenameAttachment,
  onRemoveAttachment,
  onOpenHistory,
  pendingInserts,
  onInsertsHandled,
  busy,
}: {
  projectId: string;
  stepId: BlueprintStepId;
  section: BlueprintSection;
  presets: BlueprintPreset[];
  agentFile: BlueprintAgentFileTarget | undefined;
  onSave: (text: string) => void;
  onToggleInclude: (value: boolean) => void;
  onPickAttachments: (stepId: BlueprintStepId) => void;
  onAddAttachment: (displayName: string, dataUrl: string) => void;
  onRenameAttachment: (attachmentId: string, displayName: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onOpenHistory: () => void;
  /** Files the last add call created, waiting to be dropped in at the caret. */
  pendingInserts: BlueprintAttachment[];
  onInsertsHandled: () => void;
  busy: boolean;
}): React.JSX.Element {
  const meta = blueprintStep(stepId);
  const [text, setText] = useState(section.text);
  const [dragOver, setDragOver] = useState(false);
  const saved = useRef(section.text);
  const editor = useRef<MarkdownEditorHandle>(null);

  // Re-seed when the step changes, or when a restored revision lands from
  // somewhere other than this box.
  useEffect(() => {
    setText(section.text);
    saved.current = section.text;
  }, [section.text]);

  // A file finishes writing in the main process well after the drop happened or
  // the picker closed, so its markdown goes in once it comes back rather than
  // optimistically on a name the store might have refused.
  // Ids are tracked so a re-render between the insert and the queue clearing
  // cannot place the same file twice.
  const inserted = useRef(new Set<string>());
  useEffect(() => {
    const fresh = pendingInserts.filter((attachment) => !inserted.current.has(attachment.id));
    if (fresh.length === 0) return;
    for (const attachment of fresh) {
      inserted.current.add(attachment.id);
      editor.current?.insertAtCaret(`${blueprintFileMarkdown(attachment)}\n`);
    }
    onInsertsHandled();
  }, [pendingInserts, onInsertsHandled]);

  function commit(): void {
    if (text === saved.current) return;
    saved.current = text;
    onSave(text);
  }

  function applyPreset(preset: BlueprintPreset): void {
    const addition = preset.text.trim();
    const next = text.trim() ? `${text.replace(/\s*$/, '')}\n${addition}\n` : `${addition}\n`;
    setText(next);
    saved.current = next;
    onSave(next);
  }

  async function removeAttachment(attachment: BlueprintAttachment): Promise<void> {
    const inText = referencedAttachmentNames(text).has(attachment.fileName);
    const confirmed = await confirmDialog({
      title: `Delete "${attachment.displayName}"?`,
      description: inText
        ? 'The file goes for good, and the place it sits in this step goes with it. Whatever you wrote around it stays.'
        : 'The file goes for good. This step does not refer to it.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!confirmed) return;
    // The removal rewrites the step's text in the main process, and that comes
    // back through `section.text` and re-seeds the box, so this must not also
    // save the copy it is holding.
    saved.current = text;
    onRemoveAttachment(attachment.id);
  }

  const usedFileNames = referencedAttachmentNames(text);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{meta.heading}</h3>
          <p className="text-xs text-muted-foreground">{meta.hint}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onOpenHistory}>
          <History /> History
        </Button>
      </div>

      <BlueprintPresetChips stepId={stepId} presets={presets} text={text} onApply={applyPreset} />

      <div
        className={cn('rounded-lg transition-shadow', dragOver && 'ring-2 ring-primary/60')}
        // Capture, because the events start on the textarea inside the editor.
        onBlurCapture={commit}
        onPasteCapture={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (files.length === 0) return;
          event.preventDefault();
          void addFilesAsAttachments(files, onAddAttachment);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files);
          if (files.length === 0) return;
          event.preventDefault();
          setDragOver(false);
          void addFilesAsAttachments(files, onAddAttachment);
        }}
      >
        <MarkdownEditor
          ref={editor}
          value={text}
          onChange={setText}
          onSave={commit}
          defaultHeight={380}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Markdown, with a live preview. Persian is fine here; the generated prompt comes out in
        English either way.
      </p>

      {section.textEn && section.textEn !== section.text ? (
        <details className="rounded-lg border border-border bg-muted/20 px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            English rendering used for the prompt
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-sm">{section.textEn}</p>
        </details>
      ) : null}

      <BlueprintAttachments
        projectId={projectId}
        stepId={stepId}
        attachments={section.attachments}
        usedFileNames={usedFileNames}
        onPick={onPickAttachments}
        onInsert={(attachment) =>
          editor.current?.insertAtCaret(`${blueprintFileMarkdown(attachment)}\n`)
        }
        onRename={onRenameAttachment}
        onRemove={(attachment) => void removeAttachment(attachment)}
        busy={busy}
      />

      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-background/40 px-3 py-2.5">
        <Checkbox
          id={`blueprint-include-${stepId}`}
          checked={section.includeInAgentFile}
          onCheckedChange={(value) => onToggleInclude(value === true)}
          className="mt-0.5"
        />
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor={`blueprint-include-${stepId}`} className="cursor-pointer">
            Include this in{' '}
            <span className="font-mono text-xs">{agentFile?.relativePath ?? 'AGENTS.md'}</span>
          </Label>
          <p className="text-xs text-muted-foreground">
            Ticked steps go into one managed block, so re-running this never duplicates anything.
            Attached files become a mention by name: that file lives in your repository, where the
            images do not.
          </p>
        </div>
      </div>
    </div>
  );
}
