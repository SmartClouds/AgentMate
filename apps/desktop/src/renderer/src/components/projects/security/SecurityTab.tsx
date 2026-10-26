import type { Project, SecurityScannerId } from '@runova/core';
import { getSecurityScanner, SECURITY_SCANNERS } from '@runova/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronDown, History, Play, RefreshCw, Shield } from '@/components/icons';
import { ProjectEmptyState } from '@/components/projects/ProjectDetailChrome';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { confirmDialog } from '@/stores/confirmStore';
import { ScannerPicker } from './ScannerPicker';
import { ScannerSetupDialog } from './ScannerSetupDialog';
import { ScanProgressPanel } from './ScanProgressPanel';
import { SecurityCopyMenu } from './SecurityCopyMenu';
import { SecurityReport } from './SecurityReport';
import { useSecurityScan } from './useSecurityScan';

/**
 * The project's Security section: pick scanners, run them, read one merged report, hand it to an
 * agent to fix.
 *
 * The section is never hidden when nothing is installed. Someone who has not installed a scanner
 * is exactly the person who needs to be told these exist.
 */
export function SecurityTab({ project }: { project: Project }): React.JSX.Element {
  const navigate = useNavigate();
  const [setupScanner, setSetupScanner] = useState<SecurityScannerId | null>(null);
  const {
    preflight,
    preflightLoading,
    refreshPreflight,
    report,
    reportLoading,
    history,
    config,
    saveConfig,
    selection,
    toggleScanner,
    running,
    progress,
    runScan,
    cancel,
    loadScan,
  } = useSecurityScan(project.id);

  const anyReady = preflight.some((p) => p.ready);
  const canRun = selection.length > 0 && !running;

  async function startScan(): Promise<void> {
    // Strix is an autonomous agent that runs the code and bills the user's own API key, so it
    // never starts on a single click the way the static scanners do.
    const paid = selection
      .map((id) => getSecurityScanner(id))
      .filter((scanner) => scanner?.costsMoney);
    if (paid.length > 0) {
      const confirmed = await confirmDialog({
        title: `Run ${paid.map((s) => s?.name).join(' and ')}?`,
        description:
          'This runs an autonomous agent that executes your code in a sandbox and drives an LLM to find and prove vulnerabilities. It can take up to an hour and spends tokens against your own API key.',
        confirmLabel: 'Run it',
      });
      if (!confirmed) return;
    }
    runScan({ scannerIds: selection });
  }

  // `running` guards this too: a scan started here keeps going in the main process, and a tool
  // uninstalled mid-run must not replace a live scan with an empty state.
  if (!anyReady && !preflightLoading && !report && !running) {
    return (
      <div className="space-y-4">
        <ProjectEmptyState
          icon={Shield}
          title="No security scanners installed yet"
          description="Install Semgrep, Trivy, CodeQL, Bearer, SonarQube, or Strix from the Agent Tools page, then come back here to scan this project and get one merged report you can hand to an agent."
          action={
            <Button onClick={() => navigate('/tools?tab=security')}>
              <Shield className="h-4 w-4" /> Browse security tools
            </Button>
          }
        />
        <ScannerPicker
          preflight={preflight}
          loading={preflightLoading}
          selection={selection}
          onToggle={toggleScanner}
          onConfigure={setSetupScanner}
          disabled={running}
        />
        <ScannerSetupDialog
          // Keyed so each scanner's form starts from that scanner's saved settings rather than
          // inheriting a draft from whichever dialog was opened last.
          key={setupScanner ?? 'none'}
          scannerId={setupScanner}
          config={config}
          projectName={project.name}
          onClose={() => setSetupScanner(null)}
          onSave={(patch) => {
            saveConfig.mutate(patch, {
              onSuccess: () => toast.success('Scanner settings saved.'),
            });
          }}
          onSuggestLanguage={() => window.runova.security.suggestCodeqlLanguage(project.id)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="glass">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <Shield className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Security scan</p>
              <p className="text-xs text-muted-foreground">
                {running
                  ? 'Running. You can leave this tab, the scan keeps going.'
                  : report
                    ? `Last run ${new Date(report.createdAt).toLocaleString()}`
                    : 'Pick the scanners to run against this project.'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {history.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="gap-1.5">
                    <History className="h-4 w-4" />
                    History
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel>Previous scans</DropdownMenuLabel>
                  {history.map((entry) => (
                    <DropdownMenuItem key={entry.id} onClick={() => void loadScan(entry.id)}>
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                        <span className="truncate text-xs">
                          {new Date(entry.createdAt).toLocaleString()}
                        </span>
                        <Badge variant="outline">{entry.score}</Badge>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <SimpleTooltip label="Re-check which scanners are installed and configured">
              <Button
                variant="outline"
                size="icon"
                aria-label="Refresh scanner status"
                disabled={running}
                onClick={() => void refreshPreflight()}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </SimpleTooltip>

            {report && !running && <SecurityCopyMenu record={report} />}

            <SimpleTooltip
              label={selection.length === 0 ? 'Select at least one scanner first' : ''}
              wrapTrigger
            >
              <Button disabled={!canRun} onClick={() => void startScan()}>
                <Play className="h-4 w-4" />
                {running ? 'Scanning...' : report ? 'Scan again' : 'Run scan'}
              </Button>
            </SimpleTooltip>
          </div>
        </CardContent>
      </Card>

      <ScannerPicker
        preflight={preflight}
        loading={preflightLoading}
        selection={selection}
        onToggle={toggleScanner}
        onConfigure={setSetupScanner}
        disabled={running}
      />

      {running && <ScanProgressPanel selection={selection} progress={progress} onCancel={cancel} />}

      {/* A report is a result, not a starting state, so the card shimmers in its own shape rather
          than blanking the page. */}
      {reportLoading && !report ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-2 w-full rounded-full" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : report ? (
        <SecurityReport record={report} />
      ) : !running ? (
        <ProjectEmptyState
          icon={Shield}
          title="No scan yet"
          description={`${SECURITY_SCANNERS.filter((s) => preflight.find((p) => p.scannerId === s.id)?.ready).length} scanner(s) ready. Run one to get a merged report with a copy button that hands every finding to an agent.`}
        />
      ) : null}

      <ScannerSetupDialog
        // Keyed so each scanner's form starts from that scanner's saved settings rather than
        // inheriting a draft from whichever dialog was opened last.
        key={setupScanner ?? 'none'}
        scannerId={setupScanner}
        config={config}
        projectName={project.name}
        onClose={() => setSetupScanner(null)}
        onSave={(patch) => {
          saveConfig.mutate(patch, {
            onSuccess: () => toast.success('Scanner settings saved.'),
          });
        }}
        onSuggestLanguage={() => window.runova.security.suggestCodeqlLanguage(project.id)}
      />
    </div>
  );
}
