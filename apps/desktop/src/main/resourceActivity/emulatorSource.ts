import { consolePortFromSerial, type EmulatorObservation } from '@runova/core';

/**
 * Reads CPU and memory for every running Android emulator, for the idle tracker.
 *
 * Two things make this harder than it looks. An emulator started outside Runova (or before a
 * restart of it, since they are launched detached) has no pid on record, so its process is found
 * through the console port the emulator listens on. And asking adb anything starts an adb server
 * if none is running, which must never happen to someone who does not use Android, so a plain
 * connect to the server port decides whether adb is worth asking at all.
 */

export interface TreeUsage {
  found: boolean;
  /** Share of all cores, 0 to 100. */
  cpuPercent: number;
  memBytes: number;
}

export interface EmulatorSourceDeps {
  /** True when an adb server is already listening. Does not start one. */
  adbServerListening(): Promise<boolean>;
  /** Serials of emulators adb reports as online, or null when adb cannot be run. */
  listOnlineEmulators(): Promise<string[] | null>;
  /** The AVD name behind each serial. A serial still booting may be missing from the answer. */
  resolveAvdNames(serials: string[]): Promise<Map<string, string>>;
  /** Pids of the emulators Runova launched itself. */
  launchedPids(): Map<string, number>;
  /** Every listening TCP port by the pid that owns it. */
  listeningPorts(): Promise<Map<number, number[]>>;
  sampleTrees(rootPids: number[]): Promise<{
    available: boolean;
    cpuReady: boolean;
    trees: Map<number, TreeUsage>;
  }>;
  cpuCount: number;
}

/** Null means emulators cannot be looked at, as opposed to an empty list: none are running. */
export type EmulatorSource = () => Promise<EmulatorObservation[] | null>;

export function createEmulatorSource(deps: EmulatorSourceDeps): EmulatorSource {
  const names = new Map<string, string>();
  const portPids = new Map<string, number>();

  const forgetGone = (serials: string[]): void => {
    const live = new Set(serials);
    for (const cache of [names, portPids]) {
      for (const serial of [...cache.keys()]) if (!live.has(serial)) cache.delete(serial);
    }
  };

  return async () => {
    if (!(await deps.adbServerListening())) {
      forgetGone([]);
      return null;
    }
    const online = await deps.listOnlineEmulators();
    if (online === null) return null;
    forgetGone(online);
    if (online.length === 0) return [];

    const unnamed = online.filter((serial) => !names.has(serial));
    if (unnamed.length > 0) {
      for (const [serial, name] of await deps.resolveAvdNames(unnamed)) names.set(serial, name);
    }
    // One that refuses console commands is still coming up. It is picked up once it answers.
    const serials = online.filter((serial) => names.has(serial));
    if (serials.length === 0) return [];

    const launched = deps.launchedPids();
    const missing = serials.filter((serial) => !launched.has(serial) && !portPids.has(serial));
    if (missing.length > 0) {
      const ports = await deps.listeningPorts();
      for (const serial of missing) {
        const port = consolePortFromSerial(serial);
        if (port === null) continue;
        for (const [pid, owned] of ports) {
          if (owned.includes(port)) {
            portPids.set(serial, pid);
            break;
          }
        }
      }
    }

    const pidOf = (serial: string): number | undefined =>
      launched.get(serial) ?? portPids.get(serial);
    const rootPids = [
      ...new Set(serials.map(pidOf).filter((pid): pid is number => pid !== undefined)),
    ];
    const sample = rootPids.length > 0 ? await deps.sampleTrees(rootPids) : null;

    return serials.map((serial): EmulatorObservation => {
      const avdName = names.get(serial) ?? serial;
      const pid = pidOf(serial);
      const tree = pid === undefined ? undefined : sample?.trees.get(pid);
      if (!sample?.available || !tree?.found) {
        // The remembered pid may belong to a process that is gone, so look it up again next time.
        portPids.delete(serial);
        return { serial, avdName, cpuPercent: null, memBytes: null, measurable: false };
      }
      return {
        serial,
        avdName,
        // The process tree reports a share of all cores; the rest of the tracker thinks in cores.
        cpuPercent: sample.cpuReady ? tree.cpuPercent * deps.cpuCount : null,
        memBytes: tree.memBytes,
        measurable: true,
      };
    });
  };
}
