import type {
  SecurityScannerId,
  SecurityScanRecord,
  SecuritySeverity,
  SecurityVerdict,
} from '@runova/core';
import {
  getSecurityScanner,
  SECURITY_SEVERITIES,
  SECURITY_SEVERITY_LABEL,
  SECURITY_VERDICT_LABEL,
} from '@runova/core';
import { useMemo, useState } from 'react';
import { CircleCheck, Filter, Shield, TriangleAlert } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { FindingRow, SEVERITY_BADGE } from './FindingRow';
import { ScanLogViewer } from './ScanLogViewer';

/**
 * The report. Deliberately built in the same visual language as the skills audit report
 * (components/skills/SkillAuditReport.tsx): a tinted verdict banner with a score out of 100, then
 * counts, then findings grouped worst-first. Someone who has read one should recognize the other.
 */

const VERDICT_STYLE: Record<SecurityVerdict, { frame: string; blurb: string }> = {
  safe: {
    frame: 'border-success/40 bg-success/10',
    blurb: 'Nothing the scanners that ran know how to look for turned up here.',
  },
  caution: {
    frame: 'border-warning/40 bg-warning/10',
    blurb: 'A few things are worth reading before this ships.',
  },
  risky: {
    frame: 'border-destructive/40 bg-destructive/10',
    blurb: 'There are real problems in here. Work through the criticals and highs first.',
  },
  dangerous: {
    frame: 'border-destructive/50 bg-destructive/15',
    blurb: 'Several serious findings. Fix these before this goes anywhere near production.',
  },
};

/** How many findings to render per severity group before making the user ask for the rest. */
const GROUP_RENDER_CAP = 50;

export function SecurityReport({ record }: { record: SecurityScanRecord }): React.JSX.Element {
  const [severityFilter, setSeverityFilter] = useState<SecuritySeverity[]>([]);
  const [scannerFilter, setScannerFilter] = useState<SecurityScannerId[]>([]);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<SecuritySeverity[]>([]);

  const style = VERDICT_STYLE[record.verdict];
  const total = record.findings.length;

  const scannersWithFindings = useMemo(
    () => [...new Set(record.findings.map((f) => f.scannerId))],
    [record.findings],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return record.findings.filter((finding) => {
      if (severityFilter.length > 0 && !severityFilter.includes(finding.severity)) return false;
      if (scannerFilter.length > 0 && !scannerFilter.includes(finding.scannerId)) return false;
      if (!needle) return true;
      return (
        (finding.file ?? '').toLowerCase().includes(needle) ||
        finding.title.toLowerCase().includes(needle) ||
        finding.ruleId.toLowerCase().includes(needle)
      );
    });
  }, [record.findings, severityFilter, scannerFilter, search]);

  const hasFilters = severityFilter.length > 0 || scannerFilter.length > 0 || search.trim() !== '';

  return (
    <div className="space-y-4">
      <div className={cn('flex items-center gap-4 rounded-lg border px-4 py-3', style.frame)}>
        {record.verdict === 'safe' ? (
          <CircleCheck className="h-7 w-7 shrink-0 text-foreground" />
        ) : (
          <Shield className="h-7 w-7 shrink-0 text-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {SECURITY_VERDICT_LABEL[record.verdict]}
            </span>
            <Badge variant="outline">Score {record.score}/100</Badge>
            {record.status !== 'complete' && (
              <SimpleTooltip label="Some scanners did not finish, so this report may be incomplete.">
                <Badge variant="warning">{record.status}</Badge>
              </SimpleTooltip>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{style.blurb}</p>
        </div>
      </div>

      <SeverityBar counts={record.counts} total={total} />

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>
          {total} finding{total === 1 ? '' : 's'}
        </span>
        <span>·</span>
        <span>{Math.round(record.durationMs / 1000)}s</span>
        <span>·</span>
        <span>{new Date(record.createdAt).toLocaleString()}</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {record.runs.map((run) => {
          const scanner = getSecurityScanner(run.scannerId);
          const label = `${scanner?.name ?? run.scannerId} · ${run.findingCount}`;
          return (
            <SimpleTooltip
              key={run.scannerId}
              label={
                run.error ??
                (run.warnings.length > 0
                  ? run.warnings.join(' ')
                  : `${run.findingCount} findings in ${Math.round(run.durationMs / 1000)}s`)
              }
            >
              <Badge
                variant={
                  run.status === 'ok'
                    ? 'outline'
                    : run.status === 'skipped'
                      ? 'secondary'
                      : 'destructive'
                }
              >
                {run.status === 'ok' ? label : `${scanner?.name ?? run.scannerId} · ${run.status}`}
              </Badge>
            </SimpleTooltip>
          );
        })}
      </div>

      {total === 0 ? (
        <p className="text-sm text-muted-foreground">
          No findings. That is not a guarantee of safety: it means the scanners that ran did not
          match anything they know about, so read anything security-sensitive yourself before
          trusting it.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/40 p-2.5">
            <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {SECURITY_SEVERITIES.filter((s) => record.counts[s] > 0).map((severity) => (
              <FilterChip
                key={severity}
                active={severityFilter.includes(severity)}
                onClick={() =>
                  setSeverityFilter((current) =>
                    current.includes(severity)
                      ? current.filter((s) => s !== severity)
                      : [...current, severity],
                  )
                }
              >
                {SECURITY_SEVERITY_LABEL[severity]} {record.counts[severity]}
              </FilterChip>
            ))}
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            {scannersWithFindings.map((scannerId) => (
              <FilterChip
                key={scannerId}
                active={scannerFilter.includes(scannerId)}
                onClick={() =>
                  setScannerFilter((current) =>
                    current.includes(scannerId)
                      ? current.filter((s) => s !== scannerId)
                      : [...current, scannerId],
                  )
                }
              >
                {getSecurityScanner(scannerId)?.name ?? scannerId}
              </FilterChip>
            ))}
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by file or rule..."
              className="h-7 w-48 text-xs"
            />
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="px-2.5"
                onClick={() => {
                  setSeverityFilter([]);
                  setScannerFilter([]);
                  setSearch('');
                }}
              >
                Clear
              </Button>
            )}
          </div>

          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing matches those filters.</p>
          ) : (
            <div className="space-y-4">
              {SECURITY_SEVERITIES.map((severity) => {
                const group = filtered.filter((f) => f.severity === severity);
                if (group.length === 0) return null;
                const isExpanded = expanded.includes(severity);
                const shown = isExpanded ? group : group.slice(0, GROUP_RENDER_CAP);

                return (
                  <div key={severity} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn('h-2 w-2 rounded-full', SEVERITY_BADGE[severity].dot)}
                        aria-hidden
                      />
                      <p className="text-sm font-medium text-foreground">
                        {SECURITY_SEVERITY_LABEL[severity]}
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          {group.length}
                        </span>
                      </p>
                    </div>
                    <div className="space-y-2">
                      {shown.map((finding) => (
                        <FindingRow key={finding.id} finding={finding} />
                      ))}
                    </div>
                    {group.length > shown.length && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpanded((current) => [...current, severity])}
                      >
                        Show the other {group.length - shown.length}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <ScanLogViewer runs={record.runs} />

      {record.runs.some((r) => r.status === 'failed' || r.status === 'timed-out') && (
        <div className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <TriangleAlert className="h-3.5 w-3.5" /> Some scanners did not finish
          </p>
          {record.runs
            .filter((r) => r.status === 'failed' || r.status === 'timed-out')
            .map((run) => (
              <p key={run.scannerId} className="text-xs text-muted-foreground">
                <span className="text-foreground">
                  {getSecurityScanner(run.scannerId)?.name ?? run.scannerId}:
                </span>{' '}
                {run.error ?? 'It ran out of time.'}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}

/** A single proportional bar, which reads the shape of a report faster than five numbers do. */
function SeverityBar({
  counts,
  total,
}: {
  counts: Record<SecuritySeverity, number>;
  total: number;
}): React.JSX.Element | null {
  if (total === 0) return null;
  const colors: Record<SecuritySeverity, string> = {
    critical: 'bg-destructive',
    high: 'bg-destructive/60',
    medium: 'bg-warning',
    low: 'bg-muted-foreground/50',
    info: 'bg-muted-foreground/25',
  };
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      {SECURITY_SEVERITIES.filter((s) => counts[s] > 0).map((severity) => (
        <SimpleTooltip
          key={severity}
          label={`${counts[severity]} ${SECURITY_SEVERITY_LABEL[severity].toLowerCase()}`}
        >
          <div
            className={colors[severity]}
            style={{ width: `${(counts[severity] / total) * 100}%` }}
          />
        </SimpleTooltip>
      ))}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
        active
          ? 'border-primary/50 bg-primary/15 text-foreground'
          : 'border-border text-muted-foreground hover:border-primary/30 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
