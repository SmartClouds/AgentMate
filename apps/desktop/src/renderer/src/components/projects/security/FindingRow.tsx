import type { SecurityFinding, SecuritySeverity } from '@runova/core';
import { buildFindingText, getSecurityScanner, SECURITY_SEVERITY_LABEL } from '@runova/core';
import { useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, Copy, ExternalLink, EyeOff } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export const SEVERITY_BADGE: Record<
  SecuritySeverity,
  { variant: 'destructive' | 'warning' | 'secondary' | 'outline'; dot: string }
> = {
  critical: { variant: 'destructive', dot: 'bg-destructive' },
  high: { variant: 'destructive', dot: 'bg-destructive/70' },
  medium: { variant: 'warning', dot: 'bg-warning' },
  low: { variant: 'secondary', dot: 'bg-muted-foreground/60' },
  info: { variant: 'outline', dot: 'bg-muted-foreground/40' },
};

function fenceLanguage(file: string | null): string {
  return file?.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * One finding. Collapsed it is a single scannable line; expanded it shows the excerpt, the
 * remediation, and the taxonomy tags. Each row can be copied on its own, so a single issue can be
 * handed to an agent without sending the whole report.
 */
export function FindingRow({ finding }: { finding: SecurityFinding }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const severity = SEVERITY_BADGE[finding.severity];
  const scanner = getSecurityScanner(finding.scannerId);

  const hasDetail = Boolean(
    finding.detail || finding.excerpt || finding.remediation || finding.helpUri,
  );

  async function copyFinding(): Promise<void> {
    try {
      await navigator.clipboard.writeText(buildFindingText(finding));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      toast.success('Finding copied to clipboard.');
    } catch {
      toast.error('Could not copy that finding.');
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card/60 transition-colors hover:border-primary/30">
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
          onClick={() => hasDetail && setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', severity.dot)} aria-hidden />
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">{finding.title}</span>
              {finding.redacted && (
                <SimpleTooltip label="A matched secret was masked before this left your machine.">
                  <Badge variant="outline" className="gap-1">
                    <EyeOff className="h-3 w-3" /> Masked
                  </Badge>
                </SimpleTooltip>
              )}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {finding.file && (
                <span className="font-mono">
                  {finding.file}
                  {finding.line ? `:${finding.line}` : ''}
                </span>
              )}
              <span className="text-muted-foreground/60">{scanner?.name ?? finding.scannerId}</span>
              <span className="truncate font-mono text-muted-foreground/60">{finding.ruleId}</span>
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <Badge variant={severity.variant}>{SECURITY_SEVERITY_LABEL[finding.severity]}</Badge>
          <SimpleTooltip label="Copy this finding for an agent">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Copy finding"
              onClick={() => void copyFinding()}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </SimpleTooltip>
          {hasDetail && (
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-180',
              )}
              aria-hidden
            />
          )}
        </div>
      </div>

      {open && hasDetail && (
        <div className="space-y-2.5 border-t border-border px-3 py-2.5">
          {finding.detail && finding.detail !== finding.title && (
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
              {finding.detail}
            </p>
          )}

          {finding.excerpt && (
            <pre className="overflow-x-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground">
              <code data-language={fenceLanguage(finding.file)}>{finding.excerpt}</code>
            </pre>
          )}

          {finding.packageName && (
            <p className="text-xs text-muted-foreground">
              <span className="font-mono text-foreground">
                {finding.packageName}
                {finding.installedVersion ? `@${finding.installedVersion}` : ''}
              </span>
              {finding.fixedVersion ? ` is fixed in ${finding.fixedVersion}.` : ''}
            </p>
          )}

          {finding.remediation && (
            <div className="rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2">
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                {finding.remediation}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            {finding.cve && <Badge variant="outline">{finding.cve}</Badge>}
            {finding.cwe.map((cwe) => (
              <Badge key={cwe} variant="outline">
                {cwe}
              </Badge>
            ))}
            {finding.owasp.map((owasp) => (
              <Badge key={owasp} variant="outline">
                {owasp}
              </Badge>
            ))}
            {finding.helpUri && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5"
                onClick={() =>
                  finding.helpUri && void window.runova.shell.openExternal(finding.helpUri)
                }
              >
                <ExternalLink className="h-3 w-3" /> Reference
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
