import type {
  ScannerPreflight,
  SecurityScannerId,
  SecurityScannerSettings,
  SecurityScanOptions,
  SecurityScanProgress,
  SecurityScanRecord,
} from '@runova/core';
import { SECURITY_SCANNERS } from '@runova/core';
import type { ActiveScan } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The Security tab's data layer: preflight, history, the run itself, and the live progress
 * stream. Kept out of the components so the tab body stays about layout, the same split
 * blueprint/useBlueprint.ts uses.
 */

/**
 * None of these should trip the app-wide boot overlay. A preflight probe spawns a dozen child
 * processes and a scan runs for tens of minutes, so both get per-card shimmer instead.
 */
const QUIET = { meta: { silentLoading: true } } as const;

export interface ScannerProgressState {
  phase: SecurityScanProgress['phase'];
  message: string;
  startedAt: number;
  lines: string[];
}

/** How many output lines to keep per scanner for the log drawer. */
const MAX_LOG_LINES = 200;

export function useSecurityScan(projectId: string) {
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, ScannerProgressState>>({});
  const [selectedScanners, setSelectedScanners] = useState<SecurityScannerId[] | null>(null);
  const runIdRef = useRef<string | null>(null);

  const preflightQuery = useQuery({
    queryKey: queryKeys.securityPreflight(projectId),
    queryFn: () => window.runova.security.preflight(projectId),
    // Probing six scanners is expensive, and the main process memoizes it anyway.
    staleTime: 30_000,
    ...QUIET,
  });

  const latestQuery = useQuery({
    queryKey: queryKeys.securityLatest(projectId),
    queryFn: () => window.runova.security.latest(projectId),
    ...QUIET,
  });

  const historyQuery = useQuery({
    queryKey: queryKeys.securityHistory(projectId),
    queryFn: () => window.runova.security.history(projectId),
    ...QUIET,
  });

  const configQuery = useQuery({
    queryKey: queryKeys.securityConfig(projectId),
    queryFn: () => window.runova.security.getConfig(projectId),
    ...QUIET,
  });

  /**
   * A scan keeps running in the main process after you leave the tab, so on mount we ask whether
   * one is already going and adopt its state rather than showing an idle tab over a live scan.
   */
  const activeQuery = useQuery({
    queryKey: queryKeys.securityActive(projectId),
    queryFn: () => window.runova.security.activeScan(projectId),
    // Progress events keep this fresh once adopted; the poll is a backstop for the case where
    // the run finishes while no event listener is attached.
    refetchInterval: (query) => (query.state.data ? 5000 : false),
    ...QUIET,
  });

  const active: ActiveScan | null = activeQuery.data ?? null;
  const wasActive = useRef(false);

  /**
   * The main process drops the snapshot only after the run has finished and its record has been
   * written, so this transition is the reliable point to pull the finished report in. It works
   * even when the scan completed while this tab was closed entirely.
   */
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    setProgress({});
    void queryClient.invalidateQueries({ queryKey: queryKeys.securityLatest(projectId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.securityHistory(projectId) });
  }, [active, projectId, queryClient]);

  useEffect(() => {
    if (!active) return;
    runIdRef.current = active.runId;
    setRunId(active.runId);
    setSelectedScanners(active.scannerIds);
    setProgress((current) => {
      // Only seed from the snapshot; live events are more current than a poll.
      if (Object.keys(current).length > 0) return current;
      const seeded: Record<string, ScannerProgressState> = {};
      for (const entry of active.scanners) {
        seeded[entry.scannerId] = {
          phase: entry.phase,
          message: entry.message,
          startedAt: entry.startedAt,
          lines: entry.lines,
        };
      }
      return seeded;
    });
  }, [active]);

  const preflight = preflightQuery.data ?? [];

  /**
   * Ready scanners are preselected, except the ones that cost money. Strix drives an LLM against
   * the user's own key, so it is always an explicit opt-in.
   */
  const defaultSelection = useMemo(
    () =>
      SECURITY_SCANNERS.filter(
        (scanner) =>
          !scanner.costsMoney && preflight.find((p) => p.scannerId === scanner.id)?.ready,
      ).map((scanner) => scanner.id),
    [preflight],
  );

  const selection = selectedScanners ?? defaultSelection;

  const toggleScanner = useCallback(
    (scannerId: SecurityScannerId) => {
      setSelectedScanners((current) => {
        const base = current ?? defaultSelection;
        return base.includes(scannerId)
          ? base.filter((id) => id !== scannerId)
          : [...base, scannerId];
      });
    },
    [defaultSelection],
  );

  // Live progress. Subscribed for the life of the tab rather than only during a run, so a scan
  // that is already going when the tab is reopened still reports into it.
  useEffect(() => {
    return window.runova.security.onScanProgress((payload) => {
      if (payload.projectId !== projectId) return;
      if (runIdRef.current && payload.runId !== runIdRef.current) return;
      if (!payload.scannerId) return;

      // Nudge the active-scan snapshot once the last scanner reports, so the poll notices the
      // run has ended promptly. The saved record is picked up separately, when the snapshot
      // actually goes away.
      if (payload.completedScanners >= payload.totalScanners) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.securityActive(projectId) });
      }

      setProgress((current) => {
        const scannerId = payload.scannerId as string;
        const existing = current[scannerId];
        const lines = existing ? [...existing.lines, payload.message] : [payload.message];
        return {
          ...current,
          [scannerId]: {
            phase: payload.phase,
            message: payload.message,
            startedAt: existing?.startedAt ?? Date.now(),
            lines: lines.slice(-MAX_LOG_LINES),
          },
        };
      });
    });
  }, [projectId, queryClient]);

  const runMutation = useMutation({
    mutationFn: async (options: Partial<SecurityScanOptions>): Promise<SecurityScanRecord> => {
      const id = crypto.randomUUID();
      setRunId(id);
      runIdRef.current = id;
      setProgress({});
      return window.runova.security.runScan(projectId, options, id);
    },
    onSuccess: (record) => {
      queryClient.setQueryData(queryKeys.securityLatest(projectId), record);
      void queryClient.invalidateQueries({ queryKey: queryKeys.securityHistory(projectId) });
      const failed = record.runs.filter((r) => r.status === 'failed' || r.status === 'timed-out');
      if (record.status === 'cancelled') toast.info('Scan cancelled.');
      else if (failed.length > 0) {
        toast.warning(
          `Scan finished, but ${failed.length} scanner${failed.length === 1 ? '' : 's'} did not complete.`,
        );
      } else {
        toast.success(
          record.findings.length === 0
            ? 'Scan finished with no findings.'
            : `Scan finished with ${record.findings.length} finding${record.findings.length === 1 ? '' : 's'}.`,
        );
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'The scan could not run.');
    },
    onSettled: () => {
      setRunId(null);
      runIdRef.current = null;
      void queryClient.invalidateQueries({ queryKey: queryKeys.securityActive(projectId) });
    },
    ...QUIET,
  });

  const saveConfig = useMutation({
    mutationFn: (config: SecurityScannerSettings) =>
      window.runova.security.setConfig(projectId, config),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.securityConfig(projectId) });
      // A new token or language changes what preflight says, so it has to be re-run.
      void queryClient.invalidateQueries({ queryKey: queryKeys.securityPreflight(projectId) });
    },
    ...QUIET,
  });

  const cancel = useCallback(() => {
    if (runId) void window.runova.security.cancelScan(runId);
  }, [runId]);

  const loadScan = useCallback(
    async (id: string) => {
      const record = await window.runova.security.getScan(id);
      if (record) queryClient.setQueryData(queryKeys.securityLatest(projectId), record);
    },
    [projectId, queryClient],
  );

  return {
    preflight,
    preflightLoading: preflightQuery.isPending,
    refreshPreflight: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.securityPreflight(projectId) }),
    report: latestQuery.data ?? null,
    reportLoading: latestQuery.isPending,
    history: historyQuery.data ?? [],
    config: configQuery.data ?? {},
    saveConfig,
    selection,
    toggleScanner,
    running: runMutation.isPending || active !== null,
    progress,
    runScan: runMutation.mutate,
    cancel,
    loadScan,
  };
}

export function preflightFor(
  preflight: ScannerPreflight[],
  scannerId: SecurityScannerId,
): ScannerPreflight | undefined {
  return preflight.find((p) => p.scannerId === scannerId);
}
