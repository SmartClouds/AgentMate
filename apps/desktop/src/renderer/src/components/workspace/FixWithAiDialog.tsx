import {
  DEFAULT_TARGET_AI,
  EFFORT_LABELS,
  findGroup,
  getCliDefinition,
  type Project,
  type PromptType,
  runChoiceArgs,
  targetAIForCliId,
} from '@runova/core';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Copy, Spinner, TerminalSquare, Wand2 } from '@/components/icons';
import { FOOTER_HAIRLINE, Problem, SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import {
  RunRecommendationPanel,
  useRunRecommendation,
} from '@/components/promptBuilder/RunRecommendation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { launchPromptTab, projectCliId } from '@/lib/workspace/launch';
import { useWorkspaceStore } from '@/stores/workspaceStore';

export interface FixSource {
  /** The prompt to start from, or null while what it is built from is still loading. */
  prompt: string | null;
  loadingLabel?: string;
  /** Set when what the prompt is built from could not be loaded. */
  error?: string | null;
  retry?: () => void;
}

/**
 * Hands a ready prompt to an agent CLI. The prompt is shown for a last look (and can be edited),
 * and a quick sizing picks the model and effort. Running it opens a tab with the command typed
 * and waiting for Enter. Used for failed pipeline runs and failing tests, and for running a
 * project's Blueprint prompt.
 */
export function FixWithAiDialog({
  project,
  open,
  onOpenChange,
  title,
  description,
  jobKey,
  source,
  promptType = 'Bug Fix',
  promptLabel = 'Fix prompt',
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Identifies this prompt, so the sizing survives the dialog closing and reopening. */
  jobKey: string;
  source: FixSource;
  /** What kind of work the prompt is, which shapes the sizing. */
  promptType?: PromptType;
  /** Accessible name for the prompt box. */
  promptLabel?: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  // Until the user types, the prompt follows the source; after that it belongs to them.
  const [edited, setPrompt] = useState<string | null>(null);
  const prompt = edited ?? source.prompt ?? '';
  const analyzedFor = useRef<string | null>(null);
  const cliId = projectCliId(project);
  const cli = cliId ? getCliDefinition(cliId) : undefined;
  const targetAI = (cliId && targetAIForCliId(cliId)) || DEFAULT_TARGET_AI;

  const recommendation = useRunRecommendation({
    jobKey,
    generated: prompt,
    promptType,
    targetAI,
  });

  // Size the prompt as soon as it exists, so the model and effort are ready by the time the
  // user has read it. Edits after that mark the sizing stale; the panel offers a re-run.
  const { analyze } = recommendation;
  useEffect(() => {
    if (!open || !prompt || analyzedFor.current === jobKey) return;
    analyzedFor.current = jobKey;
    analyze({ prompt });
  }, [open, prompt, analyze, jobKey]);

  // The model and effort are the user's to change in the panel below, and editing the prompt
  // afterwards must not quietly drop what they picked, so the flags come from the current choice
  // rather than from the (by then stale) sizing.
  const profile = recommendation.recommendation?.profile ?? null;
  const choice = recommendation.choice;
  const runArgs = profile && choice ? runChoiceArgs(profile, choice) : [];
  const suggestion =
    profile?.cliId && choice && runArgs.length > 0
      ? {
          cliId: profile.cliId,
          args: runArgs,
          label: [choice.model.label, choice.effort ? EFFORT_LABELS[choice.effort] : null]
            .filter(Boolean)
            .join(' · '),
        }
      : null;

  function openFix(launch: { cliId: string; runArgs?: string[]; runLabel?: string }): void {
    if (!prompt.trim()) return;
    const ws = useWorkspaceStore.getState().workspaces[project.id];
    const group = ws ? findGroup(ws.root, ws.focusedGroupId) : null;
    const tabId = launchPromptTab(project, { ...launch, prompt }, group?.id);
    if (!tabId) return;
    onOpenChange(false);
    navigate(`/workspace/${project.id}`);
    const name = getCliDefinition(launch.cliId)?.name ?? 'the agent';
    toast.success(`Starting ${name}`, {
      description: 'The prompt goes in as soon as it is ready. Press Enter in the tab to run it.',
    });
  }

  const sizing = recommendation.status === 'analyzing';
  const loading = source.prompt === null && !source.error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[min(58rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0">
        <DialogHeader className="px-5 py-4 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Wand2 className="h-4 w-4 text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-4 lg:flex-row">
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <p className={SECTION_HEADING}>Prompt</p>
            {loading ? (
              <div className={cn(SECTION_WELL, 'space-y-2')}>
                <p className="text-xs text-muted-foreground">
                  {source.loadingLabel ?? 'Getting the failure ready…'}
                </p>
                {Array.from({ length: 6 }, (_, i) => (
                  <span
                    key={i}
                    className="shimmer block h-3 rounded"
                    style={{ width: `${92 - i * 9}%` }}
                  />
                ))}
              </div>
            ) : source.error && edited === null ? (
              <Problem message={source.error} onRetry={source.retry} />
            ) : (
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                spellCheck={false}
                aria-label={promptLabel}
                className="min-h-[18rem] flex-1 resize-none p-3 font-mono text-[12px] leading-relaxed"
              />
            )}
          </div>
          {/* The sizing is a suggestion: the model and effort stay editable right up to Run. */}
          <div className={cn(SECTION_WELL, 'min-h-0 shrink-0 overflow-y-auto lg:w-[21rem]')}>
            <RunRecommendationPanel state={recommendation} />
          </div>
        </div>

        <DialogFooter
          className={cn(
            FOOTER_HAIRLINE,
            'flex-row items-center gap-2 px-5 py-3 sm:justify-between',
          )}
        >
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            disabled={!prompt}
            onClick={() => {
              void navigator.clipboard.writeText(prompt);
              toast.success('Prompt copied');
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            Copy prompt
          </Button>
          <div className="flex items-center gap-2">
            {suggestion && cliId && suggestion.cliId !== cliId ? (
              <Button
                variant="soft"
                size="sm"
                disabled={!prompt}
                onClick={() => openFix({ cliId })}
              >
                Open in {cli?.name ?? 'default CLI'}
              </Button>
            ) : null}
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!prompt || (!suggestion && !cliId)}
              onClick={() =>
                openFix(
                  suggestion
                    ? {
                        cliId: suggestion.cliId,
                        runArgs: suggestion.args,
                        runLabel: suggestion.label,
                      }
                    : { cliId: cliId ?? '' },
                )
              }
            >
              {sizing ? (
                <Spinner className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <TerminalSquare className="h-3.5 w-3.5" />
              )}
              {suggestion
                ? `Run on ${suggestion.label}`
                : sizing
                  ? `Open in ${cli?.name ?? 'agent'} (sizing…)`
                  : `Open in ${cli?.name ?? 'agent'}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
