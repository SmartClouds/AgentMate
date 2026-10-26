import { SKILL_RISK_CATEGORIES } from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Shield, Spinner, X } from '@/components/icons';
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
import type { SkillAuditRecord, SkillAuditTarget } from '../../../../shared/apiTypes';
import { SkillAuditReport, SkillAuditVerdictBadge } from './SkillAuditReport';
import {
  DEFAULT_CLI_VALUE,
  deepReviewInput,
  SkillDeepReviewOptions,
} from './SkillDeepReviewOptions';

/** What the dialog is checking, plus the name to show while it does. */
export interface SkillSecurityTarget {
  target: SkillAuditTarget;
  skillName: string;
  /** Stable id used to look up this skill's earlier scans; mirrors what the audit stores. */
  skillId: string;
}

/**
 * A check can take minutes when a CLI review is on, and this dialog shows its own progress and a
 * cancel button, so it must not raise the app-wide loading overlay over itself.
 */
const AUDIT_META = { silentLoading: true } as const;

export function SkillSecurityDialog({
  subject,
  onOpenChange,
}: {
  subject: SkillSecurityTarget | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [deepReview, setDeepReview] = useState(false);
  const [cliId, setCliId] = useState(DEFAULT_CLI_VALUE);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [result, setResult] = useState<SkillAuditRecord | null>(null);

  // A fresh target starts a fresh dialog: no leftover report from the last skill checked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the skill id is the signal to reset, the effect doesn't read it
  useEffect(() => {
    setResult(null);
    setRequestId(null);
  }, [subject?.skillId]);

  const historyQuery = useQuery({
    queryKey: queryKeys.skillAuditsFor(subject?.skillId ?? ''),
    queryFn: () => window.runova.skills.listAudits({ skillId: subject!.skillId, limit: 20 }),
    enabled: !!subject,
  });

  const auditMutation = useMutation({
    meta: AUDIT_META,
    mutationFn: async () => {
      if (!subject) throw new Error('Nothing to scan.');
      const id = crypto.randomUUID();
      setRequestId(id);
      return window.runova.skills.runAudit({
        target: subject.target,
        ...deepReviewInput(deepReview, cliId),
        requestId: id,
      });
    },
    onSettled: () => setRequestId(null),
    onSuccess: (response) => {
      if (response.cancelled) {
        toast.info('Security check cancelled.');
        return;
      }
      if (!response.ok || !response.record) {
        toast.error(response.error ?? 'The security check could not run.');
        return;
      }
      setResult(response.record);
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillAudits });
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillAuditsLatest });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const running = auditMutation.isPending;
  const shown = result ?? historyQuery.data?.[0] ?? null;
  const showingEarlierScan = !result && !!shown;
  const earlierChecks = (historyQuery.data ?? []).filter((entry) => entry.id !== shown?.id);

  return (
    <Dialog open={!!subject} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <Shield className="h-4 w-4" />
            Security check: {subject?.skillName}
          </DialogTitle>
          <DialogDescription>
            Reads the skill's own files and looks for the {SKILL_RISK_CATEGORIES.length} risk
            patterns below. Nothing is installed or run to do this.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 -my-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-1">
          <div className="rounded-lg border border-border bg-card/60 px-3 py-3">
            <SkillDeepReviewOptions
              enabled={deepReview}
              onEnabledChange={setDeepReview}
              cliId={cliId}
              onCliIdChange={setCliId}
              disabled={running}
            />
          </div>

          {running && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4 animate-spin" />
              {deepReview
                ? 'Scanning the files, then waiting on the CLI review. This can take a minute.'
                : 'Scanning the skill files…'}
            </p>
          )}

          {!running && shown && (
            <div className="space-y-3">
              {showingEarlierScan && (
                <p className="text-xs text-muted-foreground">
                  Showing the last check, from {new Date(shown.createdAt).toLocaleString()}.
                </p>
              )}
              <SkillAuditReport record={shown} />
            </div>
          )}

          {!running && !shown && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">This skill has not been checked yet.</p>
              <div className="flex flex-wrap gap-1.5">
                {SKILL_RISK_CATEGORIES.map((category) => (
                  <Badge key={category.id} variant="outline">
                    {category.label}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {earlierChecks.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Earlier checks</p>
              {earlierChecks.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-left text-xs hover:bg-card"
                  onClick={() => setResult(entry)}
                >
                  <span className="text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleString()}
                    {entry.deepReview ? ` · ${entry.cliName ?? 'CLI'} review` : ''}
                  </span>
                  <SkillAuditVerdictBadge verdict={entry.verdict} score={entry.score} />
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          {running ? (
            <Button
              type="button"
              variant="soft"
              onClick={() => {
                if (requestId) void window.runova.skills.cancelAudit(requestId);
              }}
            >
              <X /> Cancel
            </Button>
          ) : (
            <Button type="button" disabled={!subject} onClick={() => auditMutation.mutate()}>
              <Shield /> {shown ? 'Check again' : 'Run security check'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
