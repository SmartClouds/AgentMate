import type { ScannerRunResult } from '@runova/core';
import { getSecurityScanner } from '@runova/core';
import { useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, Copy, TerminalSquare } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The output each scanner produced, kept with the run.
 *
 * A scan can take the better part of an hour and nobody watches the whole thing, so the log is
 * saved alongside the findings rather than only existing in the live progress panel. When a
 * scanner fails or returns nothing, its output is the only thing that explains why, and losing it
 * the moment the run ends would mean re-running a 45-minute scan just to read an error message.
 */
export function ScanLogViewer({ runs }: { runs: ScannerRunResult[] }): React.JSX.Element | null {
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const withLogs = runs.filter((run) => run.log && run.log.trim().length > 0);
  if (withLogs.length === 0) return null;

  async function copyLog(run: ScannerRunResult): Promise<void> {
    try {
      const name = getSecurityScanner(run.scannerId)?.name ?? run.scannerId;
      await navigator.clipboard.writeText(`# ${name} output\n\n${run.log ?? ''}`);
      setCopied(run.scannerId);
      setTimeout(() => setCopied(null), 1600);
      toast.success('Scanner output copied to clipboard.');
    } catch {
      toast.error('Could not copy that output.');
    }
  }

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <TerminalSquare className="h-3.5 w-3.5" />
        Scanner output
      </p>
      <div className="space-y-2">
        {withLogs.map((run) => {
          const scanner = getSecurityScanner(run.scannerId);
          const isOpen = open === run.scannerId;
          return (
            <div key={run.scannerId} className="rounded-lg border border-border bg-card/60">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setOpen(isOpen ? null : run.scannerId)}
                  aria-expanded={isOpen}
                >
                  <span className="text-sm font-medium text-foreground">
                    {scanner?.name ?? run.scannerId}
                  </span>
                  <Badge
                    variant={
                      run.status === 'ok'
                        ? 'outline'
                        : run.status === 'skipped'
                          ? 'secondary'
                          : 'destructive'
                    }
                  >
                    {run.status}
                  </Badge>
                  {run.exitCode !== null && (
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      exit {run.exitCode}
                    </span>
                  )}
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {Math.round(run.durationMs / 1000)}s
                  </span>
                </button>

                <SimpleTooltip label="Copy this scanner's output">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label="Copy output"
                    onClick={() => void copyLog(run)}
                  >
                    {copied === run.scannerId ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </SimpleTooltip>
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                    isOpen && 'rotate-180',
                  )}
                  aria-hidden
                />
              </div>

              {isOpen && (
                <pre className="max-h-80 overflow-auto border-t border-border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {run.log}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
