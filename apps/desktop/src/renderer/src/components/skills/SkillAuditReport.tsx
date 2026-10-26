import type { SkillAuditFinding, SkillAuditSeverity, SkillAuditVerdict } from '@runova/core';
import {
  countFindingsByCategory,
  countFindingsBySeverity,
  getSkillRiskCategory,
  SKILL_AUDIT_SEVERITIES,
  SKILL_AUDIT_VERDICT_LABEL,
  SKILL_RISK_CATEGORIES,
} from '@runova/core';
import { useMemo } from 'react';
import { CircleCheck, Shield, Sparkles, TriangleAlert } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SkillAuditRecord } from '../../../../shared/apiTypes';

const VERDICT_STYLE: Record<
  SkillAuditVerdict,
  { badge: 'success' | 'warning' | 'destructive'; frame: string; blurb: string }
> = {
  safe: {
    badge: 'success',
    frame: 'ring-success/30 bg-success/10',
    blurb: 'Nothing in this skill matched a known attack pattern.',
  },
  caution: {
    badge: 'warning',
    frame: 'ring-warning/30 bg-warning/10',
    blurb: 'A few things are worth reading before you trust this skill.',
  },
  risky: {
    badge: 'destructive',
    frame: 'ring-destructive/30 bg-destructive/10',
    blurb: 'This skill can do real damage if the findings below are what they look like.',
  },
  dangerous: {
    badge: 'destructive',
    frame: 'ring-destructive/40 bg-destructive/15',
    blurb: 'Several serious patterns matched. Do not install this without reading every finding.',
  },
};

const SEVERITY_STYLE: Record<
  SkillAuditSeverity,
  { badge: 'destructive' | 'warning' | 'secondary' | 'outline'; label: string }
> = {
  critical: { badge: 'destructive', label: 'Critical' },
  high: { badge: 'destructive', label: 'High' },
  medium: { badge: 'warning', label: 'Medium' },
  low: { badge: 'secondary', label: 'Low' },
};

export function SkillAuditVerdictBadge({
  verdict,
  score,
  className,
}: {
  verdict: SkillAuditVerdict;
  score?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <Chip tone={VERDICT_STYLE[verdict].badge} className={className}>
      {verdict === 'safe' ? <CircleCheck /> : <TriangleAlert />}
      {SKILL_AUDIT_VERDICT_LABEL[verdict]}
      {score !== undefined ? ` · ${score}` : ''}
    </Chip>
  );
}

function FindingRow({ finding }: { finding: SkillAuditFinding }): React.JSX.Element {
  const style = SEVERITY_STYLE[finding.severity];
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-card/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={style.badge}>{style.label}</Badge>
        <span className="text-sm font-medium text-foreground">{finding.title}</span>
        {finding.origin === 'ai' && (
          <Badge variant="outline" className="gap-1">
            <Sparkles className="h-3 w-3" /> CLI review
          </Badge>
        )}
      </div>
      {finding.detail && <p className="text-xs text-muted-foreground">{finding.detail}</p>}
      {finding.excerpt && (
        <pre className="overflow-x-auto rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground">
          {finding.excerpt}
        </pre>
      )}
      {finding.file && (
        <p className="font-mono text-[11px] text-muted-foreground">
          {finding.file}
          {finding.line ? `:${finding.line}` : ''}
        </p>
      )}
    </div>
  );
}

export function SkillAuditReport({ record }: { record: SkillAuditRecord }): React.JSX.Element {
  const severityCounts = useMemo(() => countFindingsBySeverity(record.findings), [record.findings]);
  const categoryCounts = useMemo(() => countFindingsByCategory(record.findings), [record.findings]);
  const flaggedCategories = new Set(categoryCounts.map((c) => c.category));
  const cleanCategories = SKILL_RISK_CATEGORIES.filter((c) => !flaggedCategories.has(c.id));
  const style = VERDICT_STYLE[record.verdict];

  const groups = useMemo(
    () =>
      categoryCounts.map((entry) => ({
        info: getSkillRiskCategory(entry.category)!,
        findings: record.findings.filter((f) => f.category === entry.category),
      })),
    [categoryCounts, record.findings],
  );

  return (
    <div className="space-y-4">
      <div
        className={cn(
          'flex items-center gap-4 rounded-lg px-4 py-3 ring-1 ring-inset',
          style.frame,
        )}
      >
        <Shield className="h-7 w-7 shrink-0 text-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {SKILL_AUDIT_VERDICT_LABEL[record.verdict]}
            </span>
            <Badge variant="outline">Score {record.score}/100</Badge>
            {record.deepReview && (
              <Badge variant="outline" className="gap-1">
                <Sparkles className="h-3 w-3" />
                {record.cliName ? `Reviewed by ${record.cliName}` : 'Deep review'}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{style.blurb}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {record.filesScanned} file{record.filesScanned === 1 ? '' : 's'} scanned
        </span>
        <span>·</span>
        <span className="truncate font-mono">{record.sourceLabel}</span>
        <span>·</span>
        <span>{new Date(record.createdAt).toLocaleString()}</span>
      </div>

      {record.findings.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {SKILL_AUDIT_SEVERITIES.filter((severity) => severityCounts[severity] > 0).map(
            (severity) => (
              <Badge key={severity} variant={SEVERITY_STYLE[severity].badge}>
                {severityCounts[severity]} {SEVERITY_STYLE[severity].label.toLowerCase()}
              </Badge>
            ),
          )}
        </div>
      )}

      {record.aiSummary && (
        <div className="space-y-1 rounded-lg border border-border bg-card/60 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Sparkles className="h-3.5 w-3.5" />
            {record.cliName ?? 'CLI'} summary
          </p>
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{record.aiSummary}</p>
        </div>
      )}

      {record.aiError && (
        <p className="text-xs text-destructive">
          The deep review did not complete: {record.aiError}
        </p>
      )}

      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The scan matched none of the {SKILL_RISK_CATEGORIES.length} risk categories. That is not a
          guarantee: it means nothing in the text looked like a known attack, so read the skill
          before trusting it with anything sensitive.
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.info.id} className="space-y-2">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {group.info.label}
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    {group.findings.length}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">{group.info.description}</p>
              </div>
              <div className="space-y-2">
                {group.findings.map((finding, index) => (
                  <FindingRow key={`${finding.ruleId}-${index}`} finding={finding} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {cleanCategories.length > 0 && groups.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Nothing found for</p>
          <div className="flex flex-wrap gap-1.5">
            {cleanCategories.map((category) => (
              <Badge key={category.id} variant="outline">
                {category.label}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
