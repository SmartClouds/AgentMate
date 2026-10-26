import {
  type MergeBlocker,
  type MergeMethod,
  mergeBlockers,
  type Project,
  type PullRequestInfo,
} from '@runova/core';
import type { MergePullRequestResult, PullRequestStatus } from '@shared/apiTypes';
import { useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, GitMerge, Spinner, TriangleAlert } from '@/components/icons';
import { Notice, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { MergeSteps } from './MergeSteps';
import { PrCard, useRevealInPanel } from './PrCard';
import { usePullRequestActions, useRecentMerges } from './usePullRequest';

const METHODS: { id: MergeMethod; label: string; description: string }[] = [
  {
    id: 'squash',
    label: 'Squash and merge',
    description: 'All commits become one commit on the base branch',
  },
  {
    id: 'merge',
    label: 'Create a merge commit',
    description: 'Keeps every commit and adds a merge commit',
  },
  {
    id: 'rebase',
    label: 'Rebase and merge',
    description: 'Replays each commit on top of the base branch',
  },
];

/** Blockers that GitHub will refuse no matter what; the rest it decides by the repo's rules. */
const HARD: ReadonlySet<MergeBlocker['kind']> = new Set(['not-open', 'draft', 'conflicts']);

function methodSteps(method: MergeMethod, pr: PullRequestInfo): string {
  if (method === 'squash') {
    return `Squash the commits of ${pr.head} into one commit on ${pr.base}, on GitHub.`;
  }
  if (method === 'rebase') return `Rebase the commits of ${pr.head} onto ${pr.base}, on GitHub.`;
  return `Merge ${pr.head} into ${pr.base} with a merge commit, on GitHub.`;
}

/** The last card of the flow: pick a method, see what's in the way, merge, and clean up. */
export function MergeCard({
  project,
  pr,
  status,
}: {
  project: Project;
  pr: PullRequestInfo;
  status: Pick<PullRequestStatus, 'dirty'>;
}): React.JSX.Element {
  const actions = usePullRequestActions(project.id);
  const method = useWorkspaceStore((s) => s.gitPanel.mergeMethods[project.id] ?? 'squash');
  const setMergeMethod = useWorkspaceStore((s) => s.setMergeMethod);
  const revealPanelSection = useRevealInPanel();
  const recordMerge = useRecentMerges((s) => s.record);
  const [cleanup, setCleanup] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MergePullRequestResult | null>(null);
  const [markingReady, setMarkingReady] = useState(false);

  const current = METHODS.find((m) => m.id === method) ?? METHODS[0]!;
  const blockers = mergeBlockers(pr);
  const dirtyBlocks = cleanup && status.dirty;
  const hard = blockers.filter((b) => HARD.has(b.kind));
  const soft = blockers.filter((b) => !HARD.has(b.kind));
  const blocked = hard.length > 0 || dirtyBlocks;

  async function merge(): Promise<void> {
    setConfirming(false);
    setRunning(true);
    setResult(null);
    try {
      const outcome = await actions.merge({
        number: pr.number,
        base: pr.base,
        head: pr.head,
        method,
        cleanup,
      });
      setResult(outcome);
      if (outcome.merged) {
        recordMerge(project.id, {
          number: pr.number,
          base: pr.base,
          head: pr.head,
          steps: outcome.steps,
        });
      }
      if (outcome.ok) toast.success(`Merged #${pr.number} into ${pr.base}`);
    } finally {
      setRunning(false);
    }
  }

  async function retryCleanup(): Promise<void> {
    setRunning(true);
    try {
      const outcome = await actions.cleanup(pr.base, pr.head);
      const merged = result?.steps.filter((step) => step.step === 'merge') ?? [];
      const next = { ...outcome, steps: [...merged, ...outcome.steps] };
      setResult(next);
      recordMerge(project.id, {
        number: pr.number,
        base: pr.base,
        head: pr.head,
        steps: next.steps,
      });
      if (outcome.ok) toast.success(`Switched to ${pr.base} and deleted ${pr.head}`);
    } finally {
      setRunning(false);
    }
  }

  async function markReady(): Promise<void> {
    setMarkingReady(true);
    try {
      await actions.markReady(pr.number);
    } finally {
      setMarkingReady(false);
    }
  }

  return (
    <PrCard title="Merge" icon={GitMerge} tone={blocked ? 'default' : 'success'}>
      <div className="space-y-2.5 px-3.5">
        {hard.length > 0 || dirtyBlocks || soft.length > 0 ? (
          <ul className="space-y-1">
            {hard.map((blocker) => (
              <li key={blocker.kind} className="flex items-center gap-1.5 text-[11.5px]">
                <TriangleAlert className="h-2.5 w-2.5 shrink-0 text-destructive" />
                <span className="min-w-0 flex-1">{blocker.message}</span>
                {blocker.kind === 'draft' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => void markReady()}
                    disabled={markingReady}
                    className="text-muted-foreground"
                  >
                    {markingReady ? (
                      <Spinner className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none" />
                    ) : null}
                    Mark ready
                  </Button>
                ) : null}
              </li>
            ))}
            {dirtyBlocks ? (
              <li className="flex items-center gap-1.5 text-[11.5px]">
                <TriangleAlert className="h-2.5 w-2.5 shrink-0 text-destructive" />
                <span className="min-w-0 flex-1">
                  You have uncommitted changes. Commit or discard them before switching branches.
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => revealPanelSection('changes')}
                  className="text-muted-foreground"
                >
                  Review changes
                </Button>
              </li>
            ) : null}
            {soft.map((blocker) => (
              <li
                key={blocker.kind}
                className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground"
              >
                <TriangleAlert className="h-2.5 w-2.5 shrink-0 text-warning" />
                <span className="min-w-0 flex-1">{blocker.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 text-[11.5px] text-success">
            <Check className="h-2.5 w-2.5" />
            Ready to merge into {pr.base}.
          </p>
        )}

        <label className="flex cursor-pointer items-start gap-2 text-[11.5px] leading-snug">
          <Checkbox
            checked={cleanup}
            onCheckedChange={(value) => setCleanup(value === true)}
            className="mt-px h-4 w-4"
          />
          <span>
            Delete <span className="font-mono">{pr.head}</span> here and on GitHub, then switch to{' '}
            <span className="font-mono">{pr.base}</span>
          </span>
        </label>

        {/* One split pill: the merge itself, then a chevron to pick how it merges. */}
        <div className="flex">
          <Button
            onClick={() => setConfirming(true)}
            disabled={blocked || running}
            className="min-w-0 flex-1 gap-1.5 rounded-r-none px-3"
          >
            {running ? (
              <Spinner className="h-3 w-3 animate-spin motion-reduce:animate-none" />
            ) : (
              <GitMerge className="h-3 w-3" />
            )}
            <span className="truncate">{current.label}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="Choose merge method"
                disabled={running}
                // The divider is an inset shadow: the app's global border colour would repaint a
                // border here.
                className="w-8 rounded-l-none px-0 shadow-[inset_1px_0_0_hsl(var(--primary-foreground)/0.25)]"
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" collisionPadding={8} className="w-[17rem]">
              {METHODS.map((option) => (
                <DropdownMenuItem
                  key={option.id}
                  onSelect={() => setMergeMethod(project.id, option.id)}
                  className="items-start"
                >
                  <Check
                    className={cn(
                      'mt-1 h-3 w-3 shrink-0',
                      option.id === method ? 'text-primary' : 'invisible',
                    )}
                  />
                  <span className="flex flex-col">
                    <span className="text-[13px] font-medium">{option.label}</span>
                    <span className="text-[11px] text-muted-foreground">{option.description}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {running && !result ? (
          <MergeSteps
            steps={[]}
            pending={cleanup ? ['merge', 'checkout', 'pull', 'delete'] : ['merge']}
          />
        ) : null}
        {result ? (
          <div
            className={cn(
              SECTION_WELL,
              'space-y-1.5 px-2.5 py-2',
              result.ok
                ? 'bg-success/[0.05] ring-success/25'
                : 'bg-destructive/[0.05] ring-destructive/25',
            )}
          >
            <MergeSteps steps={result.steps} />
            {result.merged && !result.ok ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void retryCleanup()}
                disabled={running}
                className="text-muted-foreground"
              >
                Retry cleanup
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {current.label} #{pr.number}?
            </DialogTitle>
            <DialogDescription>{pr.title}</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-[13px]">
            <li>{methodSteps(method, pr)}</li>
            {cleanup ? (
              <>
                <li>Switch to {pr.base} here and pull the merge.</li>
                <li>Delete {pr.head} here and on GitHub.</li>
              </>
            ) : null}
          </ul>
          {soft.length > 0 ? (
            <Notice tone="warning" size="sm" className="text-[12px]">
              <div className="space-y-1">
                {soft.map((blocker) => (
                  <p key={blocker.kind}>{blocker.message}</p>
                ))}
                <p className="text-muted-foreground">
                  GitHub still refuses the merge if the repository requires these.
                </p>
              </div>
            </Notice>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={() => void merge()}>
              {soft.length > 0 ? 'Merge anyway' : current.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PrCard>
  );
}
