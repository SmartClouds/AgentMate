import type { ComposeRiskSeverity } from '@runova/core';
import { useId } from 'react';
import { CircleCheck, CircleInfo } from '@/components/icons';
import { Chip, type ChipTone, SECTION_WELL } from '@/components/pageKit';
import { Checkbox } from '@/components/ui/checkbox';
import { SEVERITY_TEXT, sortRisks } from '@/lib/deploy/apps/format';
import { cn } from '@/lib/utils';

/**
 * Findings in a compose file, worst first. The ones that need it get a checkbox each; the
 * acknowledgment is recorded against the finding's id in the server's audit trail.
 */

export interface RiskItem {
  id: string;
  severity: ComposeRiskSeverity;
  message: string;
  advice?: string;
  service?: string | null;
}

/** Severity as the page kit's chip tones, which tint without a border. */
const SEVERITY_TONE: Record<ComposeRiskSeverity, ChipTone> = {
  critical: 'destructive',
  high: 'destructive',
  medium: 'warning',
  low: 'neutral',
};

export function RiskList({
  risks,
  requires,
  acknowledged,
  onAcknowledge,
  label,
}: {
  risks: readonly RiskItem[];
  /** Ids that need a checkbox; the others are listed as advice. */
  requires: readonly string[];
  acknowledged: ReadonlySet<string>;
  onAcknowledge: (id: string, accepted: boolean) => void;
  label: string;
}): React.JSX.Element {
  const ids = useId();
  const sorted = sortRisks(risks);
  const needed = sorted.filter((risk) => requires.includes(risk.id));
  const advice = sorted.filter((risk) => !requires.includes(risk.id));

  return (
    <div className="space-y-4">
      {needed.length > 0 && (
        <ul aria-label={label} className="space-y-2">
          {needed.map((risk, index) => {
            const checkboxId = `${ids}-${index}`;
            const checked = acknowledged.has(risk.id);
            return (
              <li
                key={risk.id}
                className={cn(
                  // Inset rings, since a tinted border would lose to the global border colour.
                  'flex gap-3 rounded-xl p-3 ring-1 ring-inset transition-colors',
                  checked
                    ? 'bg-foreground/[0.03] ring-foreground/[0.08]'
                    : 'bg-warning/[0.05] ring-warning/35',
                )}
              >
                <Checkbox
                  id={checkboxId}
                  checked={checked}
                  onCheckedChange={(value) => onAcknowledge(risk.id, value === true)}
                  aria-label={`I accept: ${risk.message}`}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <label
                    htmlFor={checkboxId}
                    className="flex cursor-pointer flex-wrap items-center gap-2"
                  >
                    <Chip
                      tone={SEVERITY_TONE[risk.severity]}
                      className="text-[10px] font-semibold uppercase tracking-wide"
                    >
                      {SEVERITY_TEXT[risk.severity]}
                    </Chip>
                    <span className="text-sm text-foreground">{risk.message}</span>
                  </label>
                  {risk.advice && <p className="text-xs text-muted-foreground">{risk.advice}</p>}
                  <p className="font-mono text-[10px] text-muted-foreground/80">{risk.id}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {advice.length > 0 && (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <CircleInfo className="h-3.5 w-3.5 text-muted-foreground" /> Worth fixing, nothing to
            accept
          </p>
          <ul aria-label="Advice" className="space-y-1.5">
            {advice.map((risk) => (
              <li key={risk.id} className={cn(SECTION_WELL, 'px-3 py-2')}>
                <p className="text-xs text-foreground">{risk.message}</p>
                {risk.advice && <p className="text-[11px] text-muted-foreground">{risk.advice}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {risks.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheck className="h-3.5 w-3.5 text-success" />
          Nothing risky found in the compose file.
        </p>
      )}
    </div>
  );
}
