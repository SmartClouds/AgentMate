import type { BlueprintStepId } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { MarkdownPreview } from '@/components/editor/MarkdownPreview';
import { History, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { queryKeys } from '@/lib/queryKeys';
import { persianTextProps } from '@/lib/rtl';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * The saved states of one step, or of the final prompt when `stepId` is null.
 * A restore copies the old text forward and writes a revision of its own, so the
 * log stays a log rather than becoming a tree.
 */
export function BlueprintRevisionsDialog({
  projectId,
  stepId,
  label,
  open,
  onOpenChange,
  onRestore,
  restoring,
}: {
  projectId: string;
  stepId: BlueprintStepId | null;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: (text: string) => void;
  restoring: boolean;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const revisionsQuery = useQuery({
    queryKey: queryKeys.blueprintRevisions(projectId, stepId),
    queryFn: () => window.runova.blueprints.listRevisions(projectId, stepId),
    enabled: open,
  });

  const revisions = revisionsQuery.data ?? [];
  const selected = revisions.find((entry) => entry.id === selectedId) ?? revisions[0] ?? null;

  useEffect(() => {
    if (open) setSelectedId(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(38rem,85vh)] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle>History: {label}</DialogTitle>
          <DialogDescription>
            Every save is kept, newest first. The most recent one is what is on screen now.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
          <div className="min-h-0 space-y-1 overflow-y-auto pr-1">
            {revisionsQuery.isLoading ? (
              <div className="flex justify-center py-6">
                <Spinner className="h-4 w-4 animate-spin text-primary" />
              </div>
            ) : revisions.length === 0 ? (
              <p className="px-1 py-4 text-sm text-muted-foreground">
                Nothing saved here yet. The first edit starts the history.
              </p>
            ) : (
              revisions.map((revision, index) => (
                <button
                  key={revision.id}
                  type="button"
                  onClick={() => setSelectedId(revision.id)}
                  className={cn(
                    'w-full cursor-pointer rounded-md border px-2.5 py-2 text-left transition-colors',
                    selected?.id === revision.id
                      ? 'border-primary/50 bg-primary/10'
                      : 'border-transparent hover:bg-muted/60',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{timeAgo(revision.createdAt)}</span>
                    {index === 0 ? (
                      <span className="text-[10px] uppercase tracking-wide text-primary">
                        Current
                      </span>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {revision.text.trim().length === 0 ? 'Empty' : `${revision.text.length} chars`}
                    {revision.attachmentNames.length > 0
                      ? ` · ${revision.attachmentNames.length} attached`
                      : ''}
                  </p>
                </button>
              ))
            )}
          </div>

          <div className="min-h-0 overflow-y-auto rounded-lg border border-border bg-background/40 p-3">
            {selected ? (
              <div {...persianTextProps(selected.text)}>
                <MarkdownPreview content={selected.text || '_(empty)_'} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Pick a version on the left.</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            disabled={!selected || restoring || selected.id === revisions[0]?.id}
            onClick={() => selected && onRestore(selected.text)}
          >
            {restoring ? <Spinner className="animate-spin" /> : <History />}
            Restore this version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
