import { countDotenvKeys, DEFAULT_ENV_FILE_NAMES, isEnvFileName } from '@runova/core';
import type { EnvFileSummary, ProjectEnvironment } from '@shared/apiTypes';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { MonacoEditor } from '@/components/editor/MonacoEditor';
import { Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ipcErrorMessage } from './ipcError';

export interface EnvFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: ProjectEnvironment;
  /** Set to edit a saved file; left out to add a new one. */
  file?: EnvFileSummary;
  onSaved: () => void;
}

function suggestedFileName(environment: ProjectEnvironment): string {
  const taken = new Set(environment.files.map((f) => f.fileName));
  const preferred = DEFAULT_ENV_FILE_NAMES[environment.kind];
  if (!taken.has(preferred)) return preferred;
  return taken.has('.env') ? '' : '.env';
}

export function EnvFileDialog({
  open,
  onOpenChange,
  environment,
  file,
  onSaved,
}: EnvFileDialogProps): React.JSX.Element {
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per open, not on every environment refetch
  useEffect(() => {
    if (!open) return;
    setSubmitting(false);
    setFileName(file?.fileName ?? suggestedFileName(environment));
    setContent('');
    if (!file) return;

    let cancelled = false;
    setLoading(true);
    window.runova.environments
      .readFile(environment.id, file.id)
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toast.error(ipcErrorMessage(error, 'Could not open that file.'));
        onOpenChange(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, file?.id]);

  const trimmedName = fileName.trim();
  const nameValid = isEnvFileName(trimmedName);
  const nameTaken = environment.files.some((f) => f.fileName === trimmedName && f.id !== file?.id);
  const keyCount = useMemo(() => countDotenvKeys(content), [content]);
  const canSubmit = nameValid && !nameTaken && !loading && !submitting;

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await window.runova.environments.saveFile({
        environmentId: environment.id,
        id: file?.id,
        fileName: trimmedName,
        content,
      });
      toast.success(`${trimmedName} saved.`);
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(ipcErrorMessage(error, 'Could not save that file.'));
    } finally {
      setSubmitting(false);
    }
  }

  let nameHint = 'Saved encrypted in Runova. Nothing is written to the project folder.';
  if (trimmedName && !nameValid) nameHint = 'Use a name like .env or .env.production.';
  else if (nameTaken) nameHint = `${trimmedName} is already saved in ${environment.name}.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{file ? `Edit ${file.fileName}` : 'Add env file'}</DialogTitle>
          <DialogDescription>
            {environment.name}: paste the file contents or type them in.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="env-file-name">File name</Label>
            <Input
              id="env-file-name"
              value={fileName}
              placeholder=".env.production"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => setFileName(event.target.value)}
            />
            <p
              className={
                (trimmedName && !nameValid) || nameTaken
                  ? 'text-xs text-destructive'
                  : 'text-xs text-muted-foreground'
              }
            >
              {nameHint}
            </p>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Contents</Label>
              <span className="text-xs text-muted-foreground">
                {keyCount} {keyCount === 1 ? 'key' : 'keys'}
              </span>
            </div>
            {loading ? (
              <Skeleton className="h-[360px] w-full rounded-lg" />
            ) : (
              <MonacoEditor
                value={content}
                onChange={setContent}
                language="ini"
                className="h-[360px]"
              />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {submitting && <Spinner className="h-4 w-4 animate-spin" />}
            Save file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
