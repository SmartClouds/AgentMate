import {
  type DuplicatePolicy,
  GENERIC_COLUMN_TARGETS,
  type GenericColumnTarget,
  type GenericMapping,
  VAULT_IMPORT_FORMAT_LABELS,
} from '@runova/core';
import type { VaultImportPreview, VaultImportResult } from '@shared/apiTypes';
import { vaultErrorMessage } from '@shared/vaultErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CircleCheck, FileText, Spinner, TriangleAlert, Upload } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';
import { EntryAvatar } from './EntryAvatar';
import { ENTRY_TYPE_META } from './entryTypes';

const TARGET_LABELS: Record<GenericColumnTarget, string> = {
  title: 'Title',
  username: 'Username',
  password: 'Password',
  url: 'Website',
  notes: 'Notes',
  tags: 'Tags',
  totp: 'Authenticator key',
  favorite: 'Favorite',
  extra: 'Add to notes',
  ignore: "Don't import",
};

const POLICIES: { value: DuplicatePolicy; label: string; hint: string }[] = [
  { value: 'skip', label: 'Keep the saved entry', hint: 'The version in the file is skipped.' },
  {
    value: 'replace',
    label: 'Replace the saved entry',
    hint: 'The saved entry is updated with the version from the file.',
  },
  {
    value: 'keepBoth',
    label: 'Keep both',
    hint: 'The version in the file is added as a new entry.',
  },
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function VaultImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<VaultImportPreview | null>(null);
  const [mapping, setMapping] = useState<GenericMapping | null>(null);
  const [policy, setPolicy] = useState<DuplicatePolicy>('skip');
  const [result, setResult] = useState<VaultImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    // A picked file that was never imported still sits parsed in main. Let it go.
    if (preview && !result) void window.runova.vault.importCancel(preview.token);
    onOpenChange(false);
  }

  async function choose(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const opened = await window.runova.vault.importOpen();
      if (opened) {
        setPreview(opened);
        setMapping(opened.format ? null : opened.mapping);
      }
    } catch (err) {
      setError(vaultErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remap(column: number, target: GenericColumnTarget): Promise<void> {
    if (!preview || !mapping) return;
    const next = { columns: mapping.columns.map((t, i) => (i === column ? target : t)) };
    setMapping(next);
    try {
      setPreview(await window.runova.vault.importPreview(preview.token, next));
    } catch (err) {
      setError(vaultErrorMessage(err));
    }
  }

  async function commit(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await window.runova.vault.importCommit(preview.token, mapping, policy));
      void queryClient.invalidateQueries({ queryKey: queryKeys.vaultEntries });
    } catch (err) {
      setError(vaultErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import passwords</DialogTitle>
          <DialogDescription>
            {result
              ? 'Your entries are in the vault.'
              : preview
                ? 'Check what will come in before importing.'
                : 'Bring logins over from a CSV export of your browser or password manager.'}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 min-h-0 space-y-4 overflow-y-auto px-6">
          {!preview && (
            <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border px-6 py-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Upload className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Works with exports from</p>
                <p className="text-sm text-muted-foreground">
                  Chrome, Edge, Firefox, Bitwarden, 1Password and Runova. For any other CSV you pick
                  which column is which.
                </p>
              </div>
              <Button onClick={() => void choose()} disabled={busy}>
                {busy ? (
                  <Spinner className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileText className="h-3.5 w-3.5" />
                )}
                Choose CSV file
              </Button>
            </div>
          )}

          {preview && result && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <CircleCheck className="h-8 w-8 text-success" />
              <p className="text-base font-semibold">
                Imported {plural(result.added + result.replaced, 'entry', 'entries')}
              </p>
              <p className="text-sm text-muted-foreground">
                {[
                  result.added && `${result.added} added`,
                  result.replaced && `${result.replaced} replaced`,
                  result.skipped && `${result.skipped} skipped as duplicates`,
                  result.invalid.length && `${result.invalid.length} rows couldn't be read`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <p className="max-w-md text-xs text-warning">
                Now delete {preview.fileName}. It still holds your passwords in plain text.
              </p>
            </div>
          )}

          {preview && !result && (
            <>
              <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-card/40 px-3 py-2.5">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {preview.fileName}
                </span>
                {preview.format ? (
                  <Badge variant="secondary">{VAULT_IMPORT_FORMAT_LABELS[preview.format]}</Badge>
                ) : (
                  <Badge variant="outline">Unknown layout</Badge>
                )}
              </div>

              {mapping && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Match the columns</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {preview.headers.map((header, index) => {
                      const selectId = `vault-import-column-${index}`;
                      return (
                        <div
                          key={index}
                          className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-1.5"
                        >
                          <label htmlFor={selectId} className="truncate text-sm">
                            {header || `Column ${index + 1}`}
                          </label>
                          <select
                            id={selectId}
                            aria-label={`Column "${header || index + 1}"`}
                            value={mapping.columns[index] ?? 'ignore'}
                            onChange={(event) =>
                              void remap(index, event.target.value as GenericColumnTarget)
                            }
                            className="field-surface h-7 cursor-pointer rounded-full pl-2.5 pr-1.5 text-xs"
                          >
                            {GENERIC_COLUMN_TARGETS.map((target) => (
                              <option key={target} value={target}>
                                {TARGET_LABELS[target]}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {plural(preview.importable, 'entry', 'entries')} ready to import
                </p>
                {preview.sample.length > 0 && (
                  <ul className="divide-y divide-border/60 rounded-lg border border-border/70">
                    {preview.sample.map((row, index) => (
                      <li key={index} className="flex items-center gap-3 px-3 py-2">
                        <EntryAvatar entry={row} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{row.title}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {row.username || row.host || ENTRY_TYPE_META[row.type].label}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {preview.importable > preview.sample.length && (
                  <p className="text-xs text-muted-foreground">
                    and {preview.importable - preview.sample.length} more
                  </p>
                )}
              </div>

              {preview.skipped.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    {plural(
                      preview.skipped.length,
                      "row can't be imported",
                      "rows can't be imported",
                    )}
                  </summary>
                  <ul className="mt-1.5 space-y-0.5 pl-4">
                    {preview.skipped.slice(0, 20).map((skip) => (
                      <li key={skip.row}>
                        Row {skip.row}: {skip.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {preview.duplicates.identical > 0 && (
                <p className="text-xs text-muted-foreground">
                  {preview.duplicates.identical} already in your vault, so they're skipped.
                </p>
              )}

              {preview.duplicates.conflict > 0 && (
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">
                    {plural(preview.duplicates.conflict, 'entry differs', 'entries differ')} from
                    what's saved
                  </legend>
                  {POLICIES.map((option) => (
                    <label
                      key={option.value}
                      className={cn(
                        'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2',
                        policy === option.value
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-border/70',
                      )}
                    >
                      <input
                        type="radio"
                        name="vault-import-policy"
                        value={option.value}
                        checked={policy === option.value}
                        onChange={() => setPolicy(option.value)}
                        className="mt-1 accent-[hsl(var(--primary))]"
                      />
                      <span>
                        <span className="block text-sm">{option.label}</span>
                        <span className="block text-xs text-muted-foreground">{option.hint}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}

              <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                After importing, delete the CSV file. It holds your passwords in plain text.
              </p>
            </>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="soft" onClick={close}>
                Cancel
              </Button>
              {preview && (
                <Button onClick={() => void commit()} disabled={busy || preview.importable === 0}>
                  {busy && <Spinner className="h-3.5 w-3.5 animate-spin" />}
                  Import {plural(preview.importable, 'entry', 'entries')}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
