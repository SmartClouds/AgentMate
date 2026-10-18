import type { AndroidSnapshot } from '@agentmat/core';
import type { TerminalRunStatus, TerminalRunStatusResult } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import { type RunPauseInfo, syncPausesFromStatus, useRunPauseStore } from '@/stores/runPauseStore';
import {
  type RunOutput,
  type RunSessionMeta,
  runSessionsOf,
  useRunSessionStore,
} from '@/stores/runSessionStore';
import { useTerminalStore } from '@/stores/terminalStore';

/** Usage scans the whole process list, so it is read only while a run exists, and not often. */
export const RUN_STATUS_INTERVAL_MS = 5000;

/** A run whose tree is just its shell this soon after starting is still starting, not done. */
const STARTING_GRACE_MS = 10_000;

export interface RunDevice {
  name: string;
  /** The adb serial, when the device is one the Android page knows. */
  serial: string | null;
}

export interface RunRow {
  session: RunSessionMeta;
  status: TerminalRunStatus | null;
  cpuReady: boolean;
  /** Where to open a web run, one address per port, printed ones first. */
  urls: string[];
  ports: number[];
  mobile: boolean;
  device: RunDevice | null;
  /**
   * `idle` is a shell whose command has finished or crashed, so only the shell is left.
   * `paused` is a run frozen by Pause, which uses no CPU until it is resumed.
   */
  state: 'starting' | 'running' | 'idle' | 'paused';
  /** Who paused it and when, while it is paused. */
  pause: RunPauseInfo | null;
}

/** A run whose command is still going (or about to) can be paused; a finished one cannot. */
export function isPausable(row: Pick<RunRow, 'state'>): boolean {
  return row.state !== 'idle';
}

function portOfUrl(url: string): number | null {
  try {
    const port = Number(new URL(url).port);
    return port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * The addresses to offer, one for each port. With the ports the run listens on known, each gets
 * the address printed for it (or a bare localhost one), and a printed address on a port nobody
 * listens on is left out. Before that, or when the servers run outside the shell's process tree
 * (a script that `start`s each one in its own window), every printed port gets its first address.
 */
export function pickRunUrls(printed: string[], ports: number[]): string[] {
  const byPort = new Map<number, string>();
  for (const url of printed) {
    const port = portOfUrl(url);
    if (port !== null && !byPort.has(port) && (ports.length === 0 || ports.includes(port))) {
      byPort.set(port, url);
    }
  }
  for (const port of ports) {
    if (!byPort.has(port)) byPort.set(port, `http://localhost:${port}/`);
  }
  return [...byPort.values()];
}

/** Puts a printed device name to the emulator or phone the Android page shows, when it can. */
export function resolveRunDevice(name: string, snapshot: AndroidSnapshot | undefined): RunDevice {
  for (const emulator of snapshot?.emulators ?? []) {
    if (
      emulator.serial === name ||
      emulator.avd.name === name ||
      emulator.avd.displayName === name
    ) {
      return { name: emulator.avd.displayName, serial: emulator.serial };
    }
  }
  for (const phone of snapshot?.physical ?? []) {
    if (phone.device.serial === name || phone.device.model === name) {
      return { name: phone.device.model ?? phone.device.serial, serial: phone.device.serial };
    }
  }
  return { name, serial: null };
}

const BARE_SERIAL = /^emulator-\d+$/;

/**
 * Which of the devices a run printed to show. One device usually shows up under several names
 * (Flutter's "sdk gphone64 x86 64", then "emulator-5554"), so the latest that the Android page
 * can link to wins, then the latest readable name, then a bare serial.
 */
export function pickRunDevice(
  printed: readonly string[],
  snapshot: AndroidSnapshot | undefined,
): RunDevice | null {
  const latestFirst = printed.map((name) => resolveRunDevice(name, snapshot)).reverse();
  return (
    latestFirst.find((device) => device.serial !== null) ??
    latestFirst.find((device) => !BARE_SERIAL.test(device.name)) ??
    latestFirst[0] ??
    null
  );
}

export function buildRunRows(
  runs: readonly RunSessionMeta[],
  outputs: Record<string, RunOutput>,
  result: TerminalRunStatusResult | undefined,
  snapshot: AndroidSnapshot | undefined,
  now: number,
  paused: Record<string, RunPauseInfo> = {},
): RunRow[] {
  const byId = new Map((result?.sessions ?? []).map((status) => [status.sessionId, status]));
  return runs.map((session) => {
    const output = outputs[session.id];
    const status = byId.get(session.id) ?? null;
    const ports = status?.ports ?? [];
    const devices = output?.devices ?? [];
    const mobile = session.run.kind === 'mobile' || devices.length > 0;
    let state: RunRow['state'] = 'running';
    if (!status) state = 'starting';
    else if (!status.alive || status.processCount <= 1) {
      state = now - session.run.startedAt < STARTING_GRACE_MS ? 'starting' : 'idle';
    }
    const pause = paused[session.id] ?? null;
    if (pause) state = 'paused';
    return {
      session,
      status,
      cpuReady: result?.cpuReady ?? false,
      urls: pickRunUrls(output?.urls ?? [], ports),
      ports,
      mobile,
      device: pickRunDevice(devices, snapshot),
      state,
      pause,
    };
  });
}

/** Every project run in the drawer, with what it is using and where it can be reached. */
export function useRunRows(): RunRow[] {
  const sessions = useTerminalStore((s) => s.sessions);
  const outputs = useRunSessionStore((s) => s.outputs);
  const paused = useRunPauseStore((s) => s.paused);
  const runs = useMemo(() => runSessionsOf(sessions), [sessions]);
  const ids = runs.map((run) => run.id);

  const statusQuery = useQuery({
    queryKey: queryKeys.terminalRunStatus(ids),
    queryFn: async () => {
      const askedAt = Date.now();
      return { ...(await window.agentmat.terminal.runStatus(ids)), askedAt };
    },
    enabled: ids.length > 0,
    refetchInterval: ids.length > 0 ? RUN_STATUS_INTERVAL_MS : false,
    placeholderData: (previous) => previous,
    meta: { silentLoading: true },
  });

  // A window opened after a pause, or a main that restarted, learns about it from the poll.
  useEffect(() => {
    if (statusQuery.data) syncPausesFromStatus(statusQuery.data.sessions, statusQuery.data.askedAt);
  }, [statusQuery.data]);

  // Only reads what the Android segment already polls; never asks adb itself.
  const androidQuery = useQuery({
    queryKey: queryKeys.androidSnapshot,
    queryFn: () => window.agentmat.android.refresh(),
    enabled: false,
    meta: { silentLoading: true },
  });

  return buildRunRows(runs, outputs, statusQuery.data, androidQuery.data, Date.now(), paused);
}
