import type { RootCheckView } from '@agentmat/studio';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { studioClient } from '../client';
import { Button, CircleCheck, cn, FolderOpen, Input, Label, TriangleAlert } from '../kit';
import { studioKeys } from '../queryKeys';

/**
 * A folder field with Browse and a live check: while the user types or picks, the folder is
 * checked against the rules (outside the project, writable, not synced) and every problem is
 * said in words with its own icon, never by colour alone.
 */

export interface StorageLocationFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The project the folder is for, so a folder inside its source is caught. */
  projectId: string | null;
  description?: string;
  /** Tells the parent whether the folder passed, for enabling Save. */
  onCheck?: (check: RootCheckView | null) => void;
}

const CHECK_DELAY_MS = 300;

export function StorageLocationField({
  label,
  value,
  onChange,
  projectId,
  description,
  onCheck,
}: StorageLocationFieldProps): React.JSX.Element {
  const id = useId();
  const [checked, setChecked] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setChecked(value.trim()), CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);

  const check = useQuery({
    queryKey: studioKeys.rootCheck(checked, projectId),
    queryFn: () => studioClient().checkRoot(checked, projectId),
    enabled: checked.length > 0,
    meta: { silentLoading: true },
  });
  const result = checked === value.trim() ? (check.data ?? null) : null;
  useEffect(() => onCheck?.(result), [onCheck, result]);

  async function browse() {
    const picked = await studioClient().pickFolder(value || undefined);
    if (picked) onChange(picked);
  }

  const describedBy = `${id}-status`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          aria-describedby={describedBy}
          aria-invalid={result ? !result.ok : undefined}
          className="font-mono text-xs"
        />
        <Button type="button" variant="outline" onClick={() => void browse()}>
          <FolderOpen /> Browse
        </Button>
      </div>
      <div id={describedBy} aria-live="polite" className="space-y-1 text-xs">
        {value.trim() && !result && <p className="text-muted-foreground">Checking the folder...</p>}
        {result?.ok && result.problems.length === 0 && (
          <p className="flex items-center gap-1.5 text-success">
            <CircleCheck className="h-3.5 w-3.5" /> Studio can keep videos here.
          </p>
        )}
        {result?.problems.map((problem) => (
          <p
            key={problem.code}
            className={cn(
              'flex items-start gap-1.5',
              problem.level === 'error' ? 'text-destructive' : 'text-warning',
            )}
          >
            <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-medium">
                {problem.level === 'error' ? 'Not allowed: ' : 'Note: '}
              </span>
              <span className="text-foreground">{problem.message}</span>
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}
