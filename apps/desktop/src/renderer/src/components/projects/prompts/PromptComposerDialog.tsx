import type { ScheduledTaskRunMode } from '@runova/core';
import { useState } from 'react';
import { type RunSettings, RunSettingsFields } from '@/components/cli/RunSettingsFields';
import { CalendarDays, FileText, Play, Save } from '@/components/icons';
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
import { Textarea } from '@/components/ui/textarea';
import { persianTextProps } from '@/lib/rtl';
import { cn } from '@/lib/utils';
import { defaultRunAtInput, timeUntil, toLocalInputValue } from './promptItems';

export type ComposerKind = 'draft' | 'scheduled';

export interface ComposerValues {
  kind: ComposerKind;
  text: string;
  runMode: ScheduledTaskRunMode;
  /** ISO datetime. Only meaningful for automatic runs. */
  runAt: string;
  run: RunSettings;
}

export interface ComposerInitial {
  kind: ComposerKind;
  text?: string;
  runMode?: ScheduledTaskRunMode;
  runAt?: string;
  run?: RunSettings;
}

/**
 * One dialog for writing a new prompt, editing a scheduled one, and moving a draft onto the
 * schedule. A draft only needs text; a scheduled prompt also says how it runs (by hand, or by
 * itself at a set time) and in which CLI, model and effort.
 */
export function PromptComposerDialog({
  open,
  title,
  description,
  initial,
  lockKind = false,
  submitLabel,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description?: string;
  initial: ComposerInitial;
  /** Hides the Draft / Scheduled switch when the caller already decided. */
  lockKind?: boolean;
  submitLabel?: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (values: ComposerValues) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<ComposerKind>(initial.kind);
  const [text, setText] = useState(initial.text ?? '');
  const [runMode, setRunMode] = useState<ScheduledTaskRunMode>(initial.runMode ?? 'manual');
  const [runAtInput, setRunAtInput] = useState(
    initial.runAt && initial.runMode === 'auto'
      ? toLocalInputValue(new Date(initial.runAt))
      : defaultRunAtInput(),
  );
  const [run, setRun] = useState<RunSettings>(initial.run ?? {});

  const runAtMs = new Date(runAtInput).getTime();
  const runAtValid = Number.isFinite(runAtMs);
  const runAtPast = runAtValid && runAtMs <= Date.now();
  const scheduled = kind === 'scheduled';
  const canSubmit =
    text.trim().length > 0 && (!scheduled || runMode === 'manual' || (runAtValid && !runAtPast));
  const textDir = persianTextProps(text);

  function submit(): void {
    if (!canSubmit) return;
    onSubmit({
      kind,
      text: text.trim(),
      runMode,
      runAt:
        scheduled && runMode === 'auto'
          ? new Date(runAtInput).toISOString()
          : new Date().toISOString(),
      run,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {/* The dialog caps its height, so the body scrolls instead of running under the footer.
            The padding keeps focus rings from being clipped by the scroll edge. */}
        <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1 py-1">
          {!lockKind ? (
            <SegmentedChoice
              label="Save as"
              value={kind}
              onChange={setKind}
              choices={[
                {
                  id: 'draft',
                  label: 'Draft',
                  hint: 'Still writing it',
                  icon: <FileText className="h-3.5 w-3.5" />,
                },
                {
                  id: 'scheduled',
                  label: 'Scheduled',
                  hint: 'Ready to run',
                  icon: <CalendarDays className="h-3.5 w-3.5" />,
                },
              ]}
            />
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="prompt-composer-text">Prompt</Label>
            <Textarea
              id="prompt-composer-text"
              rows={7}
              autoFocus
              dir={textDir.dir}
              className={cn('max-h-[40vh] text-sm', textDir.className)}
              placeholder={
                scheduled
                  ? 'The prompt to send to the CLI.'
                  : 'Jot it down now and finish it later.'
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>

          {scheduled ? (
            <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-3">
              <SegmentedChoice
                label="Run"
                value={runMode}
                onChange={setRunMode}
                choices={[
                  {
                    id: 'manual',
                    label: 'Manually',
                    hint: 'When you press Run',
                    icon: <Play className="h-3.5 w-3.5" />,
                  },
                  {
                    id: 'auto',
                    label: 'Automatically',
                    hint: 'At a set time',
                    icon: <CalendarDays className="h-3.5 w-3.5" />,
                  },
                ]}
              />

              {runMode === 'auto' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="prompt-composer-run-at">Run at</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="prompt-composer-run-at"
                      type="datetime-local"
                      className="h-9 w-auto"
                      value={runAtInput}
                      onChange={(e) => setRunAtInput(e.target.value)}
                    />
                    {runAtValid ? (
                      <span
                        className={cn(
                          'text-xs',
                          runAtPast ? 'text-destructive' : 'text-muted-foreground',
                        )}
                      >
                        {runAtPast
                          ? 'That time has already passed.'
                          : `Runs ${timeUntil(runAtInput)}`}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Opens in a new terminal tab in this project's folder. Runova has to be running
                    at that time; if it isn't, the prompt is marked missed.
                  </p>
                </div>
              ) : null}

              <RunSettingsFields value={run} onChange={setRun} />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="soft" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button disabled={!canSubmit || pending} onClick={submit}>
            {scheduled ? <CalendarDays /> : <Save />}
            {pending ? 'Saving…' : (submitLabel ?? (scheduled ? 'Schedule' : 'Save draft'))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SegmentedChoice<Id extends string>({
  label,
  value,
  onChange,
  choices,
}: {
  label: string;
  value: Id;
  onChange: (id: Id) => void;
  choices: { id: Id; label: string; hint: string; icon: React.ReactNode }[];
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2">
        {choices.map((choice) => {
          const checked = value === choice.id;
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => onChange(choice.id)}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors',
                checked
                  ? 'border-primary/50 bg-primary/[0.08]'
                  : 'border-border/70 bg-background/40 hover:border-foreground/20 hover:bg-foreground/[0.03]',
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {choice.icon}
                {choice.label}
              </span>
              <span className="text-[11px] text-muted-foreground">{choice.hint}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
