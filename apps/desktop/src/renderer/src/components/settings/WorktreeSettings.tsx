import {
  DEFAULT_WORKTREE_SETTINGS,
  type Project,
  type ProjectWorktreeSetup,
  type WorktreeSettings,
} from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { FolderOpen, GitBranch } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

/** Typing pauses this long before a text field is saved, so each key does not write a file. */
const SAVE_DELAY_MS = 600;

function toLines(globs: string[]): string {
  return globs.join('\n');
}

function fromLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

/** Saves `value` once it has stopped changing for a moment. */
function useDebouncedSave<T>(value: T, saved: T, save: (value: T) => void): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounced on the value alone
  useEffect(() => {
    if (JSON.stringify(value) === JSON.stringify(saved)) return;
    const timer = setTimeout(() => save(value), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [JSON.stringify(value)]);
}

function LocationChoice({
  checked,
  title,
  detail,
  onSelect,
}: {
  checked: boolean;
  title: string;
  detail: React.ReactNode;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'flex flex-1 flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        checked
          ? 'border-primary/50 bg-primary/[0.07]'
          : 'border-border hover:border-foreground/25',
      )}
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="break-all font-mono text-[11px] text-muted-foreground">{detail}</span>
    </button>
  );
}

/**
 * App-wide worktree preferences: where new worktrees go, which local files they start with, and
 * whether removing one also deletes its merged branch.
 */
export function WorktreeSettingsForm(): React.JSX.Element {
  const queryClient = useQueryClient();
  const globsId = useId();
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  const saved = settingsQuery.data?.worktrees ?? DEFAULT_WORKTREE_SETTINGS;
  const [globs, setGlobs] = useState(toLines(saved.copyGlobs));

  // Follow the stored value when it loads or changes elsewhere.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the saved object
  useEffect(() => setGlobs(toLines(saved.copyGlobs)), [settingsQuery.data?.worktrees]);

  const mutation = useMutation({
    mutationFn: (next: WorktreeSettings) => window.runova.settings.update({ worktrees: next }),
    meta: { silentLoading: true },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });
  const save = (patch: Partial<WorktreeSettings>): void => mutation.mutate({ ...saved, ...patch });
  useDebouncedSave(fromLines(globs), saved.copyGlobs, (copyGlobs) => save({ copyGlobs }));

  async function pickFolder(): Promise<void> {
    const picked = await window.runova.worktrees.pickLocation(saved.baseDir);
    if (picked) save({ baseDir: picked });
  }

  // Editable fields wait for the stored values, or what arrives would overwrite what was typed.
  if (settingsQuery.isPending) {
    return (
      <div className="max-w-2xl space-y-3" aria-label="Loading worktree settings">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-20 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">New worktrees go</Label>
        <div
          role="radiogroup"
          aria-label="New worktrees go"
          className="flex flex-col gap-2 sm:flex-row"
        >
          <LocationChoice
            checked={!saved.baseDir}
            title="Next to the repository"
            detail="…/my-app.worktrees/feat-login"
            onSelect={() => save({ baseDir: null })}
          />
          <LocationChoice
            checked={Boolean(saved.baseDir)}
            title="In one folder"
            detail={saved.baseDir ? `${saved.baseDir}/my-app/feat-login` : 'Pick a folder'}
            onSelect={() => void pickFolder()}
          />
        </div>
        {saved.baseDir ? (
          <Button variant="soft" size="sm" className="gap-1.5" onClick={() => void pickFolder()}>
            <FolderOpen className="h-3.5 w-3.5" />
            Change folder
          </Button>
        ) : null}
        <p className="text-[11px] text-muted-foreground">
          The New worktree dialog can still put any one of them somewhere else.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={globsId} className="text-xs text-muted-foreground">
          Files to copy
        </Label>
        <Textarea
          id={globsId}
          value={globs}
          onChange={(event) => setGlobs(event.target.value)}
          rows={3}
          spellCheck={false}
          placeholder={'.env\n.env.*'}
          className="font-mono text-[12px]"
        />
        <p className="text-[11px] text-muted-foreground">
          One pattern per line, like .gitignore. Only files git does not track are copied, and
          nothing inside ignored folders such as node_modules. A project can set its own.
        </p>
      </div>

      <label className="flex cursor-pointer items-start justify-between gap-4">
        <span>
          <span className="block text-sm">Delete the branch when removing a merged worktree</span>
          <span className="block text-[11px] text-muted-foreground">
            A branch with commits that exist nowhere else is always kept.
          </span>
        </span>
        <Switch
          checked={saved.deleteBranchOnRemove}
          onCheckedChange={(deleteBranchOnRemove) => save({ deleteBranchOnRemove })}
          aria-label="Delete the branch when removing a merged worktree"
        />
      </label>
    </div>
  );
}

/** A project's own worktree setup: the command every new worktree runs, and files to copy. */
export function ProjectWorktreeSetupForm({ project }: { project: Project }): React.JSX.Element {
  const queryClient = useQueryClient();
  const commandId = useId();
  const globsId = useId();
  const appGlobs = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  }).data?.worktrees?.copyGlobs;
  const saved = project.worktreeSetup;
  const [command, setCommand] = useState(saved.command);
  const [globs, setGlobs] = useState(toLines(saved.copyGlobs ?? []));

  const mutation = useMutation({
    mutationFn: (next: ProjectWorktreeSetup) =>
      window.runova.projects.update(project.id, { worktreeSetup: next }),
    meta: { silentLoading: true },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
  });
  const save = (patch: Partial<ProjectWorktreeSetup>): void =>
    mutation.mutate({ command: command.trim(), copyGlobs: saved.copyGlobs, ...patch });

  useDebouncedSave(command.trim(), saved.command, (next) => save({ command: next }));
  useDebouncedSave(
    saved.copyGlobs === null ? null : fromLines(globs),
    saved.copyGlobs,
    (copyGlobs) => save({ copyGlobs }),
  );

  const ownGlobs = saved.copyGlobs !== null;
  return (
    <div className="max-w-2xl space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={commandId} className="text-xs text-muted-foreground">
          Setup command
        </Label>
        <Input
          id={commandId}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="pnpm install"
          spellCheck={false}
          className="font-mono text-[12px]"
        />
        <p className="text-[11px] text-muted-foreground">
          Runs in its own terminal tab in every new worktree of {project.name}. Leave empty to run
          nothing.
        </p>
      </div>
      <div className="space-y-2">
        <label className="flex cursor-pointer items-center justify-between gap-4">
          <span className="text-sm">Its own files to copy</span>
          <Switch
            checked={ownGlobs}
            onCheckedChange={(on) => {
              const next = on ? [...(appGlobs ?? DEFAULT_WORKTREE_SETTINGS.copyGlobs)] : null;
              setGlobs(toLines(next ?? []));
              save({ copyGlobs: next });
            }}
            aria-label={`Its own files to copy for ${project.name}`}
          />
        </label>
        {ownGlobs ? (
          <Textarea
            id={globsId}
            aria-label="Files to copy"
            value={globs}
            onChange={(event) => setGlobs(event.target.value)}
            rows={3}
            spellCheck={false}
            className="font-mono text-[12px]"
          />
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Uses the app-wide patterns:{' '}
            {(appGlobs ?? DEFAULT_WORKTREE_SETTINGS.copyGlobs).join(', ') || 'none'}
          </p>
        )}
      </div>
    </div>
  );
}

/** The project page's Worktrees card, under its Git tab. */
export function ProjectWorktreeSetupCard({ project }: { project: Project }): React.JSX.Element {
  return (
    <section aria-label="Worktrees" className="glass mt-4 rounded-xl p-4">
      <div className="mb-3 flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <GitBranch className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">Worktrees</h3>
          <p className="text-xs text-muted-foreground">
            What a new worktree of {project.name} starts with. Create one from the Workspace: the
            rail, the header's branch switcher, or Ctrl+Shift+N.
          </p>
        </div>
      </div>
      <ProjectWorktreeSetupForm key={project.id} project={project} />
    </section>
  );
}
