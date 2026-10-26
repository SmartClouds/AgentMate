import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FolderOpen, Globe, Shield, Spinner } from '@/components/icons';
import { Chip, GLASS_CARD, SearchPill } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import type { AuditSourceSkill, SkillAuditRecord } from '../../../../shared/apiTypes';
import { SkillAuditVerdictBadge } from './SkillAuditReport';
import {
  DEFAULT_CLI_VALUE,
  deepReviewInput,
  SkillDeepReviewOptions,
} from './SkillDeepReviewOptions';
import type { SkillSecurityTarget } from './SkillSecurityDialog';

/**
 * A batch reports progress on its own button, so it must not raise the app-wide loading overlay
 * (see `useAppLoadingOverlay`). Blanking the page would hide the very list being worked through.
 */
const BATCH_META = { silentLoading: true } as const;

/**
 * Checks a skill that Runova knows nothing about: a folder on disk, or a GitHub address.
 * Nothing is added as a repository and nothing is installed, which is the point. The location is
 * browsed first so a repository holding twenty skills lists them instead of guessing at one.
 */
export function AdHocSkillScanner({
  auditBySkillId,
  onCheck,
}: {
  /** Last verdict per skill id, so a location already checked says so before it is checked again. */
  auditBySkillId: Map<string, SkillAuditRecord>;
  onCheck: (subject: SkillSecurityTarget) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [debouncedInput, setDebouncedInput] = useState('');
  /** Results from a "Check all" run, so verdicts appear as each skill finishes. */
  const [batchResults, setBatchResults] = useState<Map<string, SkillAuditRecord>>(new Map());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Set once for the whole batch, rather than the dialog asking again for each skill.
  const [deepReview, setDeepReview] = useState(false);
  const [cliId, setCliId] = useState(DEFAULT_CLI_VALUE);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedInput(input.trim()), 400);
    return () => clearTimeout(timer);
  }, [input]);

  // A new location starts with a clean slate rather than the last one's verdicts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: debouncedInput is the signal to clear, the effect doesn't read it
  useEffect(() => {
    setBatchResults(new Map());
  }, [debouncedInput]);

  const previewQuery = useQuery({
    queryKey: queryKeys.auditSourcePreview(debouncedInput),
    queryFn: () => window.runova.skills.previewAuditSource(debouncedInput),
    enabled: debouncedInput.length > 0,
    // Browsing a repository is a network call, so do not repeat it on every focus change.
    staleTime: 60_000,
  });

  const preview = previewQuery.data;
  const settled = debouncedInput === input.trim() && !previewQuery.isFetching;

  /**
   * Checks every skill at this location in one go, so a repository of twenty does not need
   * twenty clicks. The deep-review switch above applies to the whole run.
   */
  const checkAllMutation = useMutation({
    meta: BATCH_META,
    mutationFn: async (skills: AuditSourceSkill[]) => {
      const records: SkillAuditRecord[] = [];
      const failed: string[] = [];
      setProgress({ done: 0, total: skills.length });

      // Sequential: a GitHub location means one download per skill, and hammering the API in
      // parallel is the fastest way to get rate-limited halfway through.
      for (const skill of skills) {
        const result = await window.runova.skills.runAudit({
          target: skill.target,
          ...deepReviewInput(deepReview, cliId),
        });
        if (result.ok && result.record) {
          const record = result.record;
          records.push(record);
          setBatchResults((prev) => new Map(prev).set(record.skillId, record));
        } else {
          failed.push(skill.name);
        }
        setProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
      }
      return { records, failed };
    },
    onSettled: () => setProgress(null),
    onSuccess: ({ records, failed }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillAudits });
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillAuditsLatest });

      const flagged = records.filter((record) => record.verdict !== 'safe');
      if (records.length === 0) {
        toast.error('None of those skills could be scanned.');
      } else if (flagged.length > 0) {
        toast.warning(
          `Checked ${records.length} skills, ${flagged.length} need a look: ${flagged
            .map((record) => record.skillName)
            .join(', ')}.`,
        );
      } else {
        toast.success(`Checked ${records.length} skills, nothing flagged.`);
      }
      if (failed.length > 0) {
        toast.error(`Could not scan ${failed.length}: ${failed.slice(0, 5).join(', ')}.`);
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const checkingAll = checkAllMutation.isPending;

  async function handleBrowse(): Promise<void> {
    const picked = await window.runova.skills.pickLocalRepository(input.trim() || null);
    if (picked) {
      setInput(picked);
      setDebouncedInput(picked);
    }
  }

  return (
    <section aria-label="Check any skill" className={cn(GLASS_CARD, 'space-y-3 p-4')}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <Shield className="h-4 w-4" />
        </div>
        <div className="space-y-0.5">
          <h2 className="text-sm font-semibold text-foreground">Check any skill</h2>
          <p className="text-xs text-muted-foreground">
            A folder on this machine or a skill published on GitHub. It does not have to be
            installed, and it does not have to be added as a repository.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        {/* The address and the browse button share one pill, like the API Client's URL bar. */}
        <SearchPill
          label="Folder path or GitHub address"
          className="h-10 pl-3.5 pr-1"
          inputClassName="font-mono text-xs"
          placeholder="C:\skills\my-skill · github.com/owner/repo/tree/main/skills/foo · owner/repo · skills.sh/owner/repo/name"
          value={input}
          onValueChange={setInput}
          clearLabel="Clear the location"
          onPaste={(e) => {
            // Explorer copies paths wrapped in quotes, and the preview should not wait for
            // the debounce when a whole location arrives at once.
            const pasted = e.clipboardData.getData('text').trim().replace(/^"|"$/g, '');
            if (!pasted) return;
            e.preventDefault();
            setInput(pasted);
            setDebouncedInput(pasted);
          }}
          trailing={
            <SimpleTooltip label="Browse for a folder">
              <Button
                type="button"
                variant="ghost"
                aria-label="Browse for a folder"
                className="shrink-0 px-3 text-foreground/85 hover:bg-foreground/[0.08] hover:text-foreground"
                onClick={() => void handleBrowse()}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Browse</span>
              </Button>
            </SimpleTooltip>
          }
        />
        <p className="px-1 text-xs text-muted-foreground">
          A GitHub link can point at the repository, a branch, or the skill's own folder. Pasting a
          whole "npx skills add …" command works too.
        </p>
      </div>

      {!settled && debouncedInput.length > 0 && (
        <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5 animate-spin" />
          {preview?.kind === 'github' ||
          /github|skills\.sh|^[\w.-]+\/[\w.-]+$/i.test(debouncedInput)
            ? 'Reading the repository…'
            : 'Looking at that location…'}
        </p>
      )}

      {settled && previewQuery.isError && (
        <p className="px-1 text-xs text-destructive">{(previewQuery.error as Error).message}</p>
      )}

      {settled && preview?.error && (
        <p className="px-1 text-xs text-destructive">{preview.error}</p>
      )}

      {settled && preview && preview.skills.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Chip tone="primary">
                {preview.kind === 'github' ? (
                  <Globe className="h-3 w-3" />
                ) : (
                  <FolderOpen className="h-3 w-3" />
                )}
                {preview.kind === 'github' ? 'GitHub' : 'Local folder'}
              </Chip>
              <span className="truncate font-mono">{preview.label}</span>
              <span>·</span>
              <span>
                {preview.skills.length} skill{preview.skills.length === 1 ? '' : 's'} found
              </span>
            </div>
            <Button
              className="shrink-0"
              disabled={checkingAll}
              onClick={() => checkAllMutation.mutate(preview.skills)}
            >
              {checkingAll ? (
                <>
                  <Spinner className="h-3.5 w-3.5 animate-spin" />
                  {progress ? `Checking ${progress.done + 1} of ${progress.total}…` : 'Checking…'}
                </>
              ) : (
                <>
                  <Shield /> Check all ({preview.skills.length})
                </>
              )}
            </Button>
          </div>

          <div className="rounded-lg bg-foreground/[0.03] px-3 py-2.5">
            <SkillDeepReviewOptions
              enabled={deepReview}
              onEnabledChange={setDeepReview}
              cliId={cliId}
              onCliIdChange={setCliId}
              disabled={checkingAll}
              batchHint={
                preview.skills.length > 1
                  ? `Check all runs the CLI once per skill, so ${preview.skills.length} skills will take a while.`
                  : undefined
              }
            />
          </div>

          <div className="settings-rows rail-scroll max-h-72 overflow-y-auto rounded-lg bg-foreground/[0.03]">
            {preview.skills.map((skill) => {
              const skillId =
                skill.target.kind === 'folder'
                  ? skill.target.path
                  : skill.target.kind === 'githubPath'
                    ? `${skill.target.repo}/${skill.target.path || skill.target.skillName}`
                    : skill.name;
              // A verdict from the run in progress wins over the last stored one.
              const audit = batchResults.get(skillId) ?? auditBySkillId.get(skillId);
              return (
                <div
                  key={`${skill.name}:${skill.location}`}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{skill.name}</span>
                      {audit && (
                        <SkillAuditVerdictBadge verdict={audit.verdict} score={audit.score} />
                      )}
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {skill.location}
                    </p>
                  </div>
                  <SimpleTooltip
                    label={
                      audit
                        ? 'Open this check, or run it again with a CLI review'
                        : 'Check this one, with the option of a CLI review'
                    }
                  >
                    <Button
                      variant="soft"
                      size="sm"
                      className="shrink-0"
                      disabled={checkingAll}
                      onClick={() =>
                        onCheck({ skillId, skillName: skill.name, target: skill.target })
                      }
                    >
                      <Shield /> {audit ? 'Open' : 'Check'}
                    </Button>
                  </SimpleTooltip>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
