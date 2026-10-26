import type { SecurityScannerId } from '@runova/core';
import { SCAN_PHASE_LABEL, SECURITY_SCANNERS } from '@runova/core';
import { useEffect, useState } from 'react';
import { Check, ChevronDown, StopCircle, TriangleAlert } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ScannerProgressState } from './useSecurityScan';

/**
 * The live state of a running scan: one row per scanner, with a phase, a timer, and the tail of
 * its own output behind a toggle. A scan can run for the better part of an hour, so silence is
 * not an option; the user needs to see it is still working and be able to stop it.
 */
export function ScanProgressPanel({
  selection,
  progress,
  onCancel,
}: {
  selection: SecurityScannerId[];
  progress: Record<string, ScannerProgressState>;
  onCancel: () => void;
}): React.JSX.Element {
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // One shared timer rather than one per row: the elapsed counters only need second resolution.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <Card className="glass">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-foreground">Scanning</p>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onCancel}>
            <StopCircle className="h-3.5 w-3.5" /> Cancel
          </Button>
        </div>

        <div className="space-y-2">
          {selection.map((scannerId) => {
            const scanner = SECURITY_SCANNERS.find((s) => s.id === scannerId);
            const state = progress[scannerId];
            const phase = state?.phase ?? 'queued';
            const done = phase === 'done';
            const failed = phase === 'failed' || phase === 'skipped' || phase === 'cancelled';
            const active = !done && !failed && Boolean(state);
            const elapsed = state ? Math.max(0, Math.round((now - state.startedAt) / 1000)) : 0;
            const isOpen = openLog === scannerId;

            return (
              <div key={scannerId} className="rounded-lg border border-border bg-card/60">
                <div className="flex items-center gap-2.5 px-3 py-2">
                  <StatusDot done={done} failed={failed} active={active} />
                  <span className="w-24 shrink-0 text-sm font-medium text-foreground">
                    {scanner?.name ?? scannerId}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {state?.message || SCAN_PHASE_LABEL[phase]}
                  </span>
                  {state && (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {elapsed}s
                    </span>
                  )}
                  <Badge variant={done ? 'success' : failed ? 'destructive' : 'outline'}>
                    {SCAN_PHASE_LABEL[phase]}
                  </Badge>
                  {state && state.lines.length > 0 && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0"
                      aria-label={isOpen ? 'Hide output' : 'Show output'}
                      onClick={() => setOpenLog(isOpen ? null : scannerId)}
                    >
                      <ChevronDown
                        className={cn('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-180')}
                      />
                    </Button>
                  )}
                </div>

                {isOpen && state && (
                  <pre className="max-h-40 overflow-auto border-t border-border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {state.lines.join('\n')}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusDot({
  done,
  failed,
  active,
}: {
  done: boolean;
  failed: boolean;
  active: boolean;
}): React.JSX.Element {
  if (done) return <Check className="h-3.5 w-3.5 shrink-0 text-success" />;
  if (failed) return <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  return (
    <span
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        active ? 'animate-pulse bg-primary' : 'bg-muted-foreground/40',
      )}
      aria-hidden
    />
  );
}
