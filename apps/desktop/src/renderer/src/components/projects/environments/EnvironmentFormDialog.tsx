import { ENVIRONMENT_KIND_LABELS, ENVIRONMENT_KINDS, type EnvironmentKind } from '@runova/core';
import type { ProjectEnvironment } from '@shared/apiTypes';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
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
import { cn } from '@/lib/utils';
import { KIND_TONES } from './EnvironmentKindBadge';
import { ipcErrorMessage } from './ipcError';

const KIND_HINTS: Record<EnvironmentKind, string> = {
  development: 'Local machines',
  test: 'CI and test runs',
  staging: 'Pre-release checks',
  production: 'Live for real users',
  custom: 'QA, demo or anything else',
};

function EnvironmentKindPicker({
  value,
  onChange,
}: {
  value: EnvironmentKind;
  onChange: (kind: EnvironmentKind) => void;
}): React.JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // Arrow keys move the choice like any radio group; Tab leaves the group in one step.
  function handleKeyDown(event: React.KeyboardEvent, index: number): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + ENVIRONMENT_KINDS.length) % ENVIRONMENT_KINDS.length;
    onChange(ENVIRONMENT_KINDS[next]);
    buttons.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-labelledby="environment-kind-label"
      className="grid grid-cols-2 gap-2"
    >
      {ENVIRONMENT_KINDS.map((option, index) => {
        const selected = option === value;
        const tone = KIND_TONES[option];
        return (
          <button
            key={option}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'group flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left ring-1 ring-inset transition-[background-color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              option === 'custom' && 'col-span-2',
              selected
                ? tone.selected
                : 'bg-transparent ring-border hover:bg-accent/50 hover:ring-foreground/25',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full ring-[1.5px] ring-inset transition-shadow duration-150',
                selected ? tone.ring : tone.ringSoft,
              )}
            >
              <span
                className={cn(
                  'h-2 w-2 rounded-full transition-transform duration-150',
                  tone.dot,
                  selected ? 'scale-100' : 'scale-0',
                )}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  'block text-sm font-medium',
                  selected ? tone.text : 'text-foreground',
                )}
              >
                {ENVIRONMENT_KIND_LABELS[option]}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {KIND_HINTS[option]}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export interface EnvironmentFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** Set to rename an existing environment. */
  initial?: ProjectEnvironment;
  /** Kind picked from the Add menu, for a new environment. */
  initialKind?: EnvironmentKind;
  onSaved: (environment: ProjectEnvironment) => void;
}

export function EnvironmentFormDialog({
  open,
  onOpenChange,
  projectId,
  initial,
  initialKind = 'custom',
  onSaved,
}: EnvironmentFormDialogProps): React.JSX.Element {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<EnvironmentKind>('custom');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const startKind = initial?.kind ?? initialKind;
    setKind(startKind);
    setName(initial?.name ?? (startKind === 'custom' ? '' : ENVIRONMENT_KIND_LABELS[startKind]));
    setSubmitting(false);
  }, [open, initial, initialKind]);

  function pickKind(next: EnvironmentKind): void {
    // Follow the kind while the name is still one of the stock labels.
    const nameIsStock =
      !name.trim() || Object.values(ENVIRONMENT_KIND_LABELS).includes(name.trim());
    if (nameIsStock) setName(next === 'custom' ? '' : ENVIRONMENT_KIND_LABELS[next]);
    setKind(next);
  }

  async function handleSubmit(): Promise<void> {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const saved = await window.runova.environments.save({
        id: initial?.id,
        projectId,
        name: name.trim(),
        kind,
      });
      onOpenChange(false);
      onSaved(saved);
    } catch (error) {
      toast.error(ipcErrorMessage(error, 'Could not save the environment.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void handleSubmit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit environment' : 'Add environment'}</DialogTitle>
          <DialogDescription>
            Group the env files and logins this project uses for one stage, like production or
            staging.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label id="environment-kind-label">Kind</Label>
            <EnvironmentKindPicker value={kind} onChange={pickKind} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="environment-name">Name</Label>
            <Input
              id="environment-name"
              value={name}
              maxLength={60}
              placeholder="e.g. QA, Demo, EU production"
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || submitting} onClick={() => void handleSubmit()}>
            {submitting && <Spinner className="h-4 w-4 animate-spin" />}
            {initial ? 'Save' : 'Add environment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
