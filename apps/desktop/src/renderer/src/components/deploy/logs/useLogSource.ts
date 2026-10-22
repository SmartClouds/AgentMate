import { coreErrorMessage } from '@shared/coreErrors';
import type {
  AuditEventInfo,
  ContainerLogLine,
  JournalLine,
} from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { useEffect, useMemo, useState } from 'react';
import { appendLines, DEFAULT_TAIL, MAX_TEXT_LOG_TAIL } from '@/lib/deploy/containers/logs';
import {
  auditEntries,
  containerEntries,
  journalEntries,
  type LogEntry,
  MAX_ENTRIES,
  mergeEntries,
  siteEntries,
} from '@/lib/deploy/logs/entries';
import { ownedSubscription } from '@/lib/deploy/overview/subscription';

/**
 * One source of the logs center (E09 T1), followed while the viewer shows it: a container, the
 * services of an app together, a unit's journal, a site's nginx log, or the core's audit trail.
 * Every subscription belongs to the viewer and stops when the source changes or the viewer goes.
 */

export type LogSource =
  | { kind: 'container'; containerId: string; label: string }
  | {
      kind: 'stack';
      project: string;
      containers: ReadonlyArray<{ id: string; service: string }>;
      label: string;
    }
  | { kind: 'journal'; unit: string; label: string }
  | { kind: 'site'; siteId: string; logKind: 'access' | 'error'; label: string }
  | { kind: 'audit'; label: string };

/** The core follows at most four container logs per connection; an app shows that many services. */
export const MAX_STACK_SERVICES = 4;

export interface LiveSource {
  entries: LogEntry[];
  ready: boolean;
  /** Nothing more is coming: read once, the stream ended, or it failed. */
  ended: boolean;
  error: string | null;
}

interface Raw {
  containers: Record<string, ContainerLogLine[]>;
  journal: JournalLine[];
  site: string[];
  audit: AuditEventInfo[];
}

const EMPTY: Raw = { containers: {}, journal: [], site: [], audit: [] };

export function useLogSource(
  serverId: string,
  source: LogSource | null,
  options: { follow: boolean; run: number; tail?: number },
): LiveSource {
  const [raw, setRaw] = useState<Raw>(EMPTY);
  const [status, setStatus] = useState({
    ready: false,
    ended: false,
    error: null as string | null,
  });
  const { follow, run, tail = DEFAULT_TAIL } = options;
  const key = source ? JSON.stringify(source) : '';

  useEffect(() => {
    setRaw(EMPTY);
    setStatus({ ready: false, ended: false, error: null });
    if (!source) return;
    const textTail = Math.min(tail, MAX_TEXT_LOG_TAIL);
    const fail = (failure: unknown) =>
      setStatus({ ready: true, ended: true, error: coreErrorMessage(failure) });
    const quiet = setTimeout(() => setStatus((current) => ({ ...current, ready: true })), 1_500);
    const stops: Array<() => void> = [() => clearTimeout(quiet)];

    if (source.kind === 'container' || source.kind === 'stack') {
      const targets =
        source.kind === 'container'
          ? [{ id: source.containerId, origin: source.label }]
          : source.containers
              .slice(0, MAX_STACK_SERVICES)
              .map((item) => ({ id: item.id, origin: item.service }));
      for (const target of targets) {
        stops.push(
          ownedSubscription({
            listen: window.agentmat.deployDocker.onLogs,
            start: () =>
              window.agentmat.deployDocker.watchLogs({
                serverId,
                containerId: target.id,
                follow,
                tail,
              }),
            stop: window.agentmat.deployDocker.unwatchLogs,
            onEvent: (event) => {
              setRaw((current) => ({
                ...current,
                containers: {
                  ...current.containers,
                  [target.origin]: appendLines(
                    current.containers[target.origin] ?? [],
                    event.lines,
                  ),
                },
              }));
              setStatus((current) => ({
                ready: true,
                ended: current.ended || (event.ended !== undefined && targets.length === 1),
                error: event.ended?.error ?? current.error,
              }));
            },
            onError: fail,
          }),
        );
      }
    } else if (source.kind === 'journal') {
      stops.push(
        ownedSubscription({
          listen: window.agentmat.deployLogs.onJournal,
          start: () =>
            window.agentmat.deployLogs.watchJournal({
              serverId,
              unit: source.unit,
              follow,
              lines: textTail,
            }),
          stop: window.agentmat.deployLogs.unwatchJournal,
          onEvent: (event) => {
            setRaw((current) => ({
              ...current,
              journal: [...current.journal, ...event.lines].slice(-MAX_ENTRIES),
            }));
            setStatus((current) => ({
              ready: true,
              ended: current.ended || event.ended !== undefined,
              error: event.ended?.error ?? current.error,
            }));
          },
          onError: fail,
        }),
      );
    } else if (source.kind === 'site') {
      stops.push(
        ownedSubscription({
          listen: window.agentmat.deploySites.onLog,
          start: () =>
            window.agentmat.deploySites.watchLog({
              serverId,
              siteId: source.siteId,
              kind: source.logKind,
              tailLines: textTail,
            }),
          stop: window.agentmat.deploySites.unwatchLog,
          onEvent: (event) => {
            setRaw((current) => ({
              ...current,
              site: (event.reset ? event.lines : [...current.site, ...event.lines]).slice(
                -MAX_ENTRIES,
              ),
            }));
            setStatus((current) => ({
              ready: true,
              ended: current.ended || event.ended !== undefined,
              error: event.ended?.error ?? current.error,
            }));
          },
          onError: fail,
        }),
      );
    } else {
      let cancelled = false;
      window.agentmat.deploySecurity.queryAudit({ serverId, limit: 200 }).then(
        (page) => {
          if (cancelled) return;
          setRaw((current) => ({ ...current, audit: page?.events ?? [] }));
          setStatus({ ready: true, ended: true, error: null });
        },
        (failure: unknown) => {
          if (!cancelled) fail(failure);
        },
      );
      stops.push(() => {
        cancelled = true;
      });
    }
    return () => {
      for (const stop of stops) stop();
    };
  }, [serverId, key, follow, run, tail]);

  const entries = useMemo(() => {
    if (!source) return [];
    if (source.kind === 'journal') return journalEntries(raw.journal, source.unit);
    if (source.kind === 'site') return siteEntries(raw.site, source.label);
    if (source.kind === 'audit') return auditEntries(raw.audit);
    return mergeEntries(
      Object.entries(raw.containers).map(([origin, lines]) => containerEntries(lines, origin)),
    );
  }, [raw, key]);

  return { entries, ...status };
}
