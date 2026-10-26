import type { ScannerPreflight, ScannerRequirement, SecurityScannerId } from '@runova/core';
import { SECURITY_SCANNER_KIND_LABEL, SECURITY_SCANNERS } from '@runova/core';
import { useNavigate } from 'react-router-dom';
import { Clock, Download, SettingsIcon, TriangleAlert } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The scanner picker. Every scanner is always shown, installed or not, because the list itself is
 * how someone discovers that CodeQL exists; the ones that cannot run are dimmed and say why,
 * rather than being hidden.
 */
export function ScannerPicker({
  preflight,
  loading,
  selection,
  onToggle,
  onConfigure,
  disabled,
}: {
  preflight: ScannerPreflight[];
  loading: boolean;
  selection: SecurityScannerId[];
  onToggle: (id: SecurityScannerId) => void;
  onConfigure: (id: SecurityScannerId) => void;
  disabled: boolean;
}): React.JSX.Element {
  const navigate = useNavigate();

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
      {SECURITY_SCANNERS.map((scanner) => {
        const check = preflight.find((p) => p.scannerId === scanner.id);
        const ready = check?.ready ?? false;
        const selected = selection.includes(scanner.id);
        const blocker = check?.requirements.find((r) => r.status === 'unmet' && r.blocking);

        return (
          <div
            key={scanner.id}
            className={cn(
              'flex flex-col gap-2.5 rounded-xl border p-3.5 transition-colors',
              selected && ready ? 'border-primary/40 bg-primary/5' : 'border-border bg-card/60',
              !ready && 'opacity-70',
            )}
          >
            <div className="flex items-start gap-2.5">
              <Checkbox
                checked={selected && ready}
                disabled={!ready || disabled}
                onCheckedChange={() => onToggle(scanner.id)}
                aria-label={`Include ${scanner.name} in the scan`}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold text-foreground">{scanner.name}</span>
                  {scanner.costsMoney && (
                    <SimpleTooltip label="Runs an autonomous agent against your code and spends LLM tokens on your own API key.">
                      <Badge variant="warning" className="gap-1">
                        <TriangleAlert className="h-3 w-3" /> Costs tokens
                      </Badge>
                    </SimpleTooltip>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{scanner.covers}</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {scanner.kinds.map((kind) => (
                <Badge key={kind} variant="outline">
                  {SECURITY_SCANNER_KIND_LABEL[kind]}
                </Badge>
              ))}
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock className="h-3 w-3" />
                {scanner.estimate}
              </span>
            </div>

            {/* "Not installed" is a result, not a starting state, so the row shimmers until the
                probe actually says so. */}
            {loading ? (
              <Skeleton className="h-7 w-40 rounded-md" />
            ) : ready ? (
              <ReadyLine requirements={check?.requirements ?? []} />
            ) : (
              <BlockedLine
                blocker={blocker}
                onInstall={() => navigate('/tools?tab=security')}
                onConfigure={() => onConfigure(scanner.id)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ReadyLine({ requirements }: { requirements: ScannerRequirement[] }): React.JSX.Element {
  const version = requirements.find((r) => r.id === 'binary' && r.detail)?.detail;
  const warning = requirements.find((r) => r.status === 'unmet' && !r.blocking);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="success">Ready{version ? ` · ${version}` : ''}</Badge>
      {warning && (
        <SimpleTooltip label={warning.remedy}>
          <Badge variant="warning">{warning.label}</Badge>
        </SimpleTooltip>
      )}
    </div>
  );
}

function BlockedLine({
  blocker,
  onInstall,
  onConfigure,
}: {
  blocker: ScannerRequirement | undefined;
  onInstall: () => void;
  onConfigure: () => void;
}): React.JSX.Element {
  if (!blocker) return <Badge variant="outline">Not available</Badge>;

  const action = blocker.action;
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{blocker.remedy}</p>
      {action.kind === 'install-tool' && (
        <Button variant="outline" size="sm" className="gap-1 px-2.5" onClick={onInstall}>
          <Download className="h-3 w-3" /> Install
        </Button>
      )}
      {(action.kind === 'configure' || action.kind === 'start-container') && (
        <Button
          variant="outline"
          size="sm"
          className="gap-1 px-2.5"
          onClick={action.kind === 'configure' ? onConfigure : onInstall}
        >
          <SettingsIcon className="h-3 w-3" />
          {action.kind === 'configure' ? 'Set up' : 'Open its card'}
        </Button>
      )}
    </div>
  );
}
