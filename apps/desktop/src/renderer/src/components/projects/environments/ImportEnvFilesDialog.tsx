import { ENVIRONMENT_KIND_LABELS, ENVIRONMENT_KINDS, type EnvironmentKind } from '@runova/core';
import type { EnvFolderFile, EnvImportPick, ProjectEnvironment } from '@shared/apiTypes';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FileText, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { EnvironmentKindBadge } from './EnvironmentKindBadge';
import { ipcErrorMessage } from './ipcError';

interface Row {
  file: EnvFolderFile;
  selected: boolean;
  /** `env:<id>` for an existing environment or `new:<kind>` for one made on import. */
  target: string;
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** `.env.qa` becomes "Qa", for a custom environment made from that file. */
function customNameFor(fileName: string): string {
  const suffix = fileName.replace(/^\.env\.?/, '');
  return suffix ? suffix.charAt(0).toUpperCase() + suffix.slice(1) : 'Custom';
}

function newEnvironmentName(kind: EnvironmentKind, fileName: string): string {
  return kind === 'custom' ? customNameFor(fileName) : ENVIRONMENT_KIND_LABELS[kind];
}

function defaultTarget(file: EnvFolderFile, environments: ProjectEnvironment[]): string {
  if (file.savedInEnvironmentId) return `env:${file.savedInEnvironmentId}`;
  const sameKind = environments.find((e) => e.kind === file.guessedKind);
  return sameKind ? `env:${sameKind.id}` : `new:${file.guessedKind}`;
}

export interface ImportEnvFilesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  environments: ProjectEnvironment[];
  onImported: () => void;
}

export function ImportEnvFilesDialog({
  open,
  onOpenChange,
  projectId,
  environments,
  onImported,
}: ImportEnvFilesDialogProps): React.JSX.Element {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scan once per open; the environment list is read for defaults only
  useEffect(() => {
    if (!open) return;
    setRows(null);
    setError(null);
    setSubmitting(false);
    let cancelled = false;
    window.runova.environments
      .scanFolder(projectId)
      .then((files) => {
        if (cancelled) return;
        setRows(
          files.map((file) => ({
            file,
            selected: !file.isTemplate && !file.tooLarge,
            target: defaultTarget(file, environments),
          })),
        );
      })
      .catch((scanError: unknown) => {
        if (!cancelled) {
          setError(ipcErrorMessage(scanError, 'Could not read the folder.'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  // Per file, because a new custom environment is named after the file it comes from.
  function targetOptions(fileName: string): ComboboxOption[] {
    return [
      ...environments.map((e) => ({ value: `env:${e.id}`, label: e.name })),
      ...ENVIRONMENT_KINDS.map((kind) => ({
        value: `new:${kind}`,
        label: `New: ${newEnvironmentName(kind, fileName)}`,
      })),
    ];
  }

  function patchRow(fileName: string, patch: Partial<Row>): void {
    setRows((current) =>
      (current ?? []).map((row) => (row.file.fileName === fileName ? { ...row, ...patch } : row)),
    );
  }

  const selected = (rows ?? []).filter((row) => row.selected);

  async function handleImport(): Promise<void> {
    if (selected.length === 0 || submitting) return;
    const picks: EnvImportPick[] = selected.map(({ file, target }) => {
      if (target.startsWith('env:'))
        return { fileName: file.fileName, environmentId: target.slice(4) };
      const kind = target.slice(4) as EnvironmentKind;
      return {
        fileName: file.fileName,
        newEnvironment: { name: newEnvironmentName(kind, file.fileName), kind },
      };
    });

    setSubmitting(true);
    try {
      const result = await window.runova.environments.importFromFolder(projectId, picks);
      for (const message of result.errors) toast.error(message);
      if (result.imported > 0) {
        toast.success(`Imported ${result.imported} ${result.imported === 1 ? 'file' : 'files'}.`);
        onOpenChange(false);
        onImported();
      }
    } catch (importError) {
      toast.error(ipcErrorMessage(importError, 'Import failed.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import env files from the project folder</DialogTitle>
          <DialogDescription>
            Copies the .env files in the project root into Runova, encrypted. The files in the
            folder are left as they are. A file with the same name in the chosen environment is
            replaced.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {!error && rows === null && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}
        {rows?.length === 0 && (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No .env files in the root of this project folder.
          </p>
        )}
        {rows && rows.length > 0 && (
          <ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
            {rows.map(({ file, selected: isSelected, target }) => (
              <li
                key={file.fileName}
                className={cn(
                  'flex items-center gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2',
                  file.tooLarge && 'opacity-60',
                )}
              >
                <Checkbox
                  checked={isSelected}
                  disabled={file.tooLarge}
                  onCheckedChange={(checked) =>
                    patchRow(file.fileName, { selected: checked === true })
                  }
                  aria-label={`Import ${file.fileName}`}
                />
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm">{file.fileName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatSize(file.size)}
                    {file.tooLarge && ' · larger than 1 MB, skipped'}
                    {file.isTemplate && ' · looks like a template'}
                    {file.savedInEnvironmentId && ' · already saved'}
                  </p>
                </div>
                <EnvironmentKindBadge kind={file.guessedKind} className="hidden sm:inline-flex" />
                <Combobox
                  className="w-48"
                  options={targetOptions(file.fileName)}
                  value={target}
                  disabled={!isSelected}
                  onChange={(value) => value && patchRow(file.fileName, { target: value })}
                  searchPlaceholder="Environment..."
                />
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={selected.length === 0 || submitting}
            onClick={() => void handleImport()}
          >
            {submitting && <Spinner className="h-4 w-4 animate-spin" />}
            Import {selected.length > 0 ? selected.length : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
