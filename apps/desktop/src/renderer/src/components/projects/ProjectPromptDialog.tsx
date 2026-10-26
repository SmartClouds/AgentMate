import type { Project } from '@runova/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MonacoEditor } from '@/components/editor/MonacoEditor';
import { Copy, Save, Trash2 } from '@/components/icons';
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

const PLACEHOLDER_HINT =
  'Describe the stack, conventions, and constraints an agent should assume every time it works on this project.';

export interface ProjectPromptDialogProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Defines the project's standing prompt, the context an agent should start
 * from on every run. Stored on the project itself, so it survives independently
 * of whatever is in the Prompt Builder at the time.
 */
export function ProjectPromptDialog({
  project,
  open,
  onOpenChange,
}: ProjectPromptDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const saved = project.prompt ?? '';
  const [prompt, setPrompt] = useState(saved);

  // Re-seed on open rather than on every project change, so a background refetch
  // can't wipe out what's being typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seeds only on open, see comment above
  useEffect(() => {
    if (open) setPrompt(saved);
  }, [open]);

  const saveMutation = useMutation({
    mutationFn: (value: string) => window.runova.projects.update(project.id, { prompt: value }),
    onSuccess: (_result, value) => {
      toast.success(value.trim() ? 'Project prompt saved.' : 'Project prompt cleared.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast.error(`Could not save the prompt: ${error.message}`);
    },
  });

  async function handleCopy(): Promise<void> {
    await navigator.clipboard.writeText(prompt);
    toast.success('Prompt copied to clipboard.');
  }

  const dirty = prompt !== saved;
  const words = prompt.trim() ? prompt.trim().split(/\s+/).length : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Project prompt</DialogTitle>
          <DialogDescription>
            Standing context for <span className="font-medium">{project.name}</span>.{' '}
            {PLACEHOLDER_HINT}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1">
          <MonacoEditor
            value={prompt}
            onChange={setPrompt}
            language="markdown"
            className="h-[45vh] min-h-[280px]"
          />
        </div>

        <p className="text-xs text-muted-foreground">
          {words} word{words === 1 ? '' : 's'} · {prompt.length} characters
          {dirty && ' · unsaved changes'}
        </p>

        <DialogFooter className="sm:justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!prompt}
              onClick={() => void handleCopy()}
            >
              <Copy /> Copy
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={!saved || saveMutation.isPending}
              onClick={() => saveMutation.mutate('')}
            >
              <Trash2 /> Clear
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!dirty || saveMutation.isPending}
              onClick={() => saveMutation.mutate(prompt)}
            >
              <Save /> {saveMutation.isPending ? 'Saving…' : 'Save prompt'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
