import type { Project } from '@runova/core';
import type { PackageInfo, PackageManagerSection } from '@shared/apiTypes';
import { useEffect, useId, useMemo, useState } from 'react';
import { Field, FormSection } from '@/components/health/formParts';
import { TextPane, useSendToAgent } from '@/components/health/promptParts';
import { Sparkles, TerminalSquare } from '@/components/icons';
import { FOOTER_HAIRLINE, SECTION_WELL, SEGMENT_TRACK, segmentClass } from '@/components/pageKit';
import {
  buildPackageUpdatePrompt,
  bumpKind,
  type PackageCommitMode,
  promptPackages,
} from '@/components/projects/packagesCopy';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * "Update with AI" for one package manager section: choose which packages go in and how the
 * agent should go about it, and get the prompt that has the project's agent (Claude Code, say)
 * do the updates. The prompt is built here as the choices change, the same way the Health
 * "Build with AI" dialog builds its own.
 */

type Scope = 'selected' | 'outdated';

const COMMIT_MODES: { mode: PackageCommitMode; label: string }[] = [
  { mode: 'none', label: "Don't" },
  { mode: 'single', label: 'One commit' },
  { mode: 'each', label: 'Per package' },
];

function Segments<T extends string>({
  labelId,
  value,
  options,
  onChange,
}: {
  labelId: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div role="group" aria-labelledby={labelId} className={cn(SEGMENT_TRACK, 'w-full')}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(segmentClass(value === option.value), 'flex-1')}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

export function PackagesUpdateDialog({
  open,
  onOpenChange,
  project,
  section,
  sectionLabel,
  selectedPackages,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  section: PackageManagerSection;
  /** The section's name as the tab shows it ("pnpm", "NuGet (.NET)"). */
  sectionLabel: string;
  selectedPackages: PackageInfo[];
}): React.JSX.Element {
  const baseId = useId();
  const id = (name: string) => `${baseId}-${name}`;
  const hasSelection = selectedPackages.length > 0;
  const [scope, setScope] = useState<Scope>(hasSelection ? 'selected' : 'outdated');
  const [skipMajor, setSkipMajor] = useState(false);
  const [runChecks, setRunChecks] = useState(true);
  const [commit, setCommit] = useState<PackageCommitMode>('none');
  const [notes, setNotes] = useState('');

  // Each opening starts from the tab's current selection, not from what was picked last time.
  useEffect(() => {
    if (!open) return;
    setScope(hasSelection ? 'selected' : 'outdated');
    setSkipMajor(false);
    setRunChecks(true);
    setCommit('none');
    setNotes('');
  }, [open, hasSelection]);

  const outdated = useMemo(
    () => section.packages.filter((pkg) => pkg.isOutdated),
    [section.packages],
  );
  const targets = scope === 'selected' && hasSelection ? selectedPackages : outdated;
  const majorCount = targets.filter(
    (pkg) => pkg.latestVersion && bumpKind(pkg.currentVersion, pkg.latestVersion) === 'major',
  ).length;
  const options = { skipMajor, runChecks, commit, notes };
  const included = promptPackages(targets, options);
  const prompt = included.length > 0 ? buildPackageUpdatePrompt(section, targets, options) : null;
  const agent = useSendToAgent(project);

  function send(): void {
    if (prompt && agent.send(prompt)) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-[min(56rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0">
        <DialogHeader className="px-5 py-4 pr-12 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Update {sectionLabel} packages with AI
          </DialogTitle>
          <DialogDescription className="text-xs">
            Your agent updates the packages, reads the changelogs for major bumps, fixes what
            breaks, and tells you what it could not move. Choose what goes in the prompt, then send
            it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto px-5 py-4 md:grid-cols-[17rem_minmax(0,1fr)]">
          <div className="min-w-0 space-y-5">
            <FormSection title="Packages">
              <div className="space-y-1.5">
                <span id={id('scope')} className="text-sm font-medium">
                  Which
                </span>
                <Segments
                  labelId={id('scope')}
                  value={hasSelection ? scope : 'outdated'}
                  onChange={setScope}
                  options={[
                    ...(hasSelection
                      ? [
                          {
                            value: 'selected' as const,
                            label: `Selected (${selectedPackages.length})`,
                          },
                        ]
                      : []),
                    { value: 'outdated' as const, label: `All outdated (${outdated.length})` },
                  ]}
                />
              </div>
              <SwitchRow
                id={id('skip-major')}
                label="Skip major bumps"
                hint={
                  majorCount > 0
                    ? `${majorCount} of these ${majorCount === 1 ? 'is a major bump' : 'are major bumps'}.`
                    : 'None of these is a major bump.'
                }
                checked={skipMajor}
                disabled={majorCount === 0}
                onCheckedChange={setSkipMajor}
              />
            </FormSection>

            <FormSection title="After updating">
              <SwitchRow
                id={id('checks')}
                label="Run the project's checks"
                hint="Typecheck, lint, tests and build, fixing what breaks."
                checked={runChecks}
                onCheckedChange={setRunChecks}
              />
              <div className="space-y-1.5">
                <span id={id('commit')} className="text-sm font-medium">
                  Commit
                </span>
                <Segments
                  labelId={id('commit')}
                  value={commit}
                  onChange={setCommit}
                  options={COMMIT_MODES.map((one) => ({ value: one.mode, label: one.label }))}
                />
              </div>
            </FormSection>

            <FormSection title="Anything else">
              <Field
                id={id('notes')}
                label="Notes for the agent"
                optional
                hint="Added to the prompt as you write it."
              >
                <Textarea
                  id={id('notes')}
                  value={notes}
                  rows={3}
                  placeholder="Keep React on 18 for now"
                  aria-describedby={`${id('notes')}-hint`}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </Field>
            </FormSection>
          </div>

          <div className="min-w-0 space-y-2">
            <p className="text-xs text-muted-foreground">
              {included.length} package{included.length === 1 ? '' : 's'} in the prompt
            </p>
            {prompt ? (
              <TextPane
                text={prompt}
                copyLabel="Copy prompt"
                copyWhat="Prompt"
                label="Prompt for your agent"
              />
            ) : (
              <div
                className={cn(
                  SECTION_WELL,
                  'flex min-h-40 items-center justify-center text-center text-sm text-muted-foreground',
                )}
              >
                Every package here is a major bump. Turn off "Skip major bumps" to include them.
              </div>
            )}
          </div>
        </div>

        <DialogFooter className={cn(FOOTER_HAIRLINE, 'flex-row items-center gap-2 px-5 py-3')}>
          <Button size="sm" disabled={!prompt} onClick={send}>
            <TerminalSquare />
            Send to {agent.cliName ?? 'agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
