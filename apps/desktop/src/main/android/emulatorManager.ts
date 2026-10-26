import {
  type AndroidActionResult,
  type AndroidEmulator,
  type AndroidEvent,
  type AndroidPhysicalDevice,
  type AndroidSnapshot,
  type AvdSummary,
  avdFromConfig,
  bootProgressFor,
  type EmulatorLaunchOptions,
  type EmulatorState,
  emulatorLaunchArgs,
  nextFreeConsolePort,
  parseBootAnim,
  parseBootCompleted,
} from '@runova/core';

/**
 * Owns what is running.
 *
 * Two decisions shape the whole thing. First, the console port is allocated before launching and
 * passed as `-port N`, so the serial is `emulator-N` from the start: there is no window where an
 * emulator is up and we do not know which one it is. Second, boot is detected by polling what the
 * device reports rather than by `adb wait-for-device`, because that blocks with nothing to show
 * and a cold boot can take two minutes of a user staring at a spinner.
 *
 * Everything it touches is injected, so the tests drive a scripted device world rather than a real
 * SDK and the states below are asserted rather than hoped for.
 */

export interface LaunchedChild {
  pid: number;
  kill(): void;
}

export interface EmulatorManagerDeps {
  listAvds(): Promise<{ avds: AvdSummary[]; broken: { name: string; error: string }[] }>;
  listAttached(): Promise<{
    emulators: { serial: string; state: string }[];
    physical: AndroidPhysicalDevice[];
  }>;
  resolveAvdNames(serials: string[]): Promise<Map<string, string>>;
  getProp(serial: string, prop: string): Promise<string>;
  emuKill(serial: string): Promise<void>;
  launch(args: string[]): LaunchedChild;
  killTree(pid: number): void;
  emit(event: AndroidEvent): void;
  pollMs?: number;
  bootTimeoutMs?: number;
}

interface Running {
  avdName: string;
  serial: string;
  state: EmulatorState;
  /** Null for an emulator that was already up when Runova looked. */
  pid: number | null;
  child: LaunchedChild | null;
  startedAt: number;
  error: string | null;
}

const DEFAULT_POLL_MS = 1000;
const DEFAULT_BOOT_TIMEOUT_MS = 5 * 60_000;
/** How long `emu kill` gets before the process tree is killed instead. */
const GRACEFUL_STOP_MS = 20_000;

export class AndroidEmulatorManager {
  private readonly running = new Map<string, Running>();
  /** Ports handed out but not yet visible in `adb devices`, so two starts cannot collide. */
  private readonly reserved = new Set<number>();
  private pollTimer: NodeJS.Timeout | null = null;
  private lastAvds: AvdSummary[] = [];

  constructor(private readonly deps: EmulatorManagerDeps) {}

  private get pollMs(): number {
    return this.deps.pollMs ?? DEFAULT_POLL_MS;
  }

  private get bootTimeoutMs(): number {
    return this.deps.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  }

  /**
   * The pid behind each running emulator we launched. An adopted one has no pid, so it gets no
   * meters rather than a wrong number from some other process.
   */
  pidsBySerial(): Map<string, number> {
    const pids = new Map<string, number>();
    for (const record of this.running.values()) {
      if (record.state === 'running' && record.pid !== null) pids.set(record.serial, record.pid);
    }
    return pids;
  }

  stateOf(avdName: string): AndroidEmulator {
    const avd = this.lastAvds.find((a) => a.name === avdName) ?? avdFromConfig(avdName, {});
    return this.toEmulator(avd, this.running.get(avdName));
  }

  private toEmulator(avd: AvdSummary, record: Running | undefined): AndroidEmulator {
    if (!record) {
      return {
        kind: 'emulator',
        avd,
        state: 'stopped',
        serial: null,
        progress: 0,
        adopted: false,
        usage: null,
        lastLine: null,
        error: null,
      };
    }
    return {
      kind: 'emulator',
      avd,
      state: record.state,
      serial: record.serial,
      progress: bootProgressFor(record.state),
      adopted: record.pid === null,
      usage: null,
      lastLine: null,
      error: record.error,
    };
  }

  /** Reads the world and merges it with what we started. Also how adoption happens. */
  async snapshot(): Promise<AndroidSnapshot> {
    const [{ avds, broken }, attached] = await Promise.all([
      this.deps.listAvds(),
      this.deps.listAttached(),
    ]);
    this.lastAvds = avds;

    const live = new Set(attached.emulators.map((e) => e.serial));
    const knownSerials = new Set([...this.running.values()].map((r) => r.serial));
    const unknown = attached.emulators
      .map((e) => e.serial)
      .filter((serial) => !knownSerials.has(serial));

    if (unknown.length > 0) {
      // An emulator someone started in Android Studio is still theirs to use from here, so it is
      // adopted with no pid rather than left off the page.
      const names = await this.deps.resolveAvdNames(unknown);
      for (const [serial, avdName] of names) {
        if (this.running.has(avdName)) continue;
        this.running.set(avdName, {
          avdName,
          serial,
          state: 'running',
          pid: null,
          child: null,
          startedAt: Date.now(),
          error: null,
        });
      }
    }

    // Anything we thought was running that is no longer attached has gone away.
    for (const [avdName, record] of this.running) {
      if (record.state === 'running' && !live.has(record.serial)) this.running.delete(avdName);
    }

    const byName = new Map(avds.map((avd) => [avd.name, avd]));
    const emulators = avds.map((avd) => this.toEmulator(avd, this.running.get(avd.name)));
    // An emulator running an AVD the listing did not return still deserves a card.
    for (const [avdName, record] of this.running) {
      if (byName.has(avdName)) continue;
      emulators.push(this.toEmulator(avdFromConfig(avdName, {}), record));
    }

    return { sdk: undefined as never, emulators, physical: attached.physical, broken };
  }

  private setState(record: Running, state: EmulatorState, error: string | null = null): void {
    if (record.state === state && record.error === error) return;
    record.state = state;
    record.error = error;
    const avd =
      this.lastAvds.find((a) => a.name === record.avdName) ?? avdFromConfig(record.avdName, {});
    this.deps.emit({ kind: 'emulator', emulator: this.toEmulator(avd, record) });
  }

  async start(
    avdName: string,
    options: Omit<EmulatorLaunchOptions, 'avdName' | 'port'>,
  ): Promise<AndroidActionResult> {
    if (this.running.has(avdName)) {
      // A second emulator on the same AVD dies on the AVD's lock file, so refuse it here where
      // we can say why.
      return { ok: false, message: `${avdName} is already running.` };
    }

    const taken = [
      ...[...this.running.values()].map((r) => Number(r.serial.split('-')[1])),
      ...this.reserved,
    ].filter((port) => Number.isFinite(port));
    const port = nextFreeConsolePort(taken);
    if (port === null) return { ok: false, message: 'No free emulator port. Stop one first.' };

    this.reserved.add(port);
    const child = this.deps.launch(emulatorLaunchArgs({ ...options, avdName, port }));
    const record: Running = {
      avdName,
      serial: `emulator-${port}`,
      state: 'launching',
      pid: child.pid,
      child,
      startedAt: Date.now(),
      error: null,
    };
    this.running.set(avdName, record);
    this.setState(record, 'launching');
    this.ensurePolling();
    return { ok: true };
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    const tick = async (): Promise<void> => {
      await this.pollBooting();
      if (this.hasBooting()) this.pollTimer = setTimeout(() => void tick(), this.pollMs);
      else this.pollTimer = null;
    };
    this.pollTimer = setTimeout(() => void tick(), this.pollMs);
  }

  private hasBooting(): boolean {
    return [...this.running.values()].some((r) =>
      ['launching', 'connecting', 'booting', 'finishing'].includes(r.state),
    );
  }

  /** One pass over everything that is still coming up. */
  private async pollBooting(): Promise<void> {
    const booting = [...this.running.values()].filter((r) =>
      ['launching', 'connecting', 'booting', 'finishing'].includes(r.state),
    );
    if (booting.length === 0) return;

    let attached: Map<string, string>;
    try {
      const { emulators } = await this.deps.listAttached();
      attached = new Map(emulators.map((e) => [e.serial, e.state]));
    } catch {
      return;
    }

    await Promise.all(
      booting.map(async (record) => {
        if (Date.now() - record.startedAt > this.bootTimeoutMs) {
          this.setState(record, 'failed', 'The emulator did not finish booting in time.');
          return;
        }
        const adbState = attached.get(record.serial);
        if (adbState === undefined) {
          // The process is up but adb cannot see it yet.
          this.setState(record, 'launching');
          return;
        }
        if (adbState !== 'device') {
          // adb sees it but it is still `offline`, so no shell command would answer.
          this.setState(record, 'connecting');
          return;
        }

        let booted = false;
        try {
          booted = parseBootCompleted(await this.deps.getProp(record.serial, 'sys.boot_completed'));
        } catch {
          // Reachable but not answering yet; the next tick asks again.
        }
        if (!booted) {
          this.setState(record, 'booting');
          return;
        }

        let animationDone = false;
        try {
          animationDone = parseBootAnim(
            await this.deps.getProp(record.serial, 'init.svc.bootanim'),
          );
        } catch {
          animationDone = false;
        }
        this.setState(record, animationDone ? 'running' : 'finishing');
        if (animationDone) this.reserved.delete(Number(record.serial.split('-')[1]));
      }),
    );
  }

  /** Marks the state machine as connecting once a serial appears, used by the poll above. */
  private findBySerial(serial: string): Running | undefined {
    return [...this.running.values()].find((record) => record.serial === serial);
  }

  async stop(serial: string): Promise<AndroidActionResult> {
    const record = this.findBySerial(serial);
    if (record) this.setState(record, 'stopping');

    try {
      await this.deps.emuKill(serial);
      if (record) this.running.delete(record.avdName);
      return { ok: true };
    } catch {
      // `emu kill` fails silently on a device where adb is not authorized, so the process tree is
      // what actually makes Stop reliable. Only possible for an emulator we launched.
      if (!record?.child) {
        if (record) this.setState(record, 'running');
        return {
          ok: false,
          message:
            'That emulator was started outside Runova and would not shut down. Close its window instead.',
        };
      }
      await new Promise((resolve) => setTimeout(resolve, GRACEFUL_STOP_MS));
      this.deps.killTree(record.pid as number);
      this.running.delete(record.avdName);
      return { ok: true };
    }
  }

  async cancelBoot(avdName: string): Promise<AndroidActionResult> {
    const record = this.running.get(avdName);
    if (!record?.child) return { ok: false, message: 'Nothing to cancel.' };
    this.deps.killTree(record.pid as number);
    this.running.delete(avdName);
    this.reserved.delete(Number(record.serial.split('-')[1]));
    this.deps.emit({
      kind: 'emulator',
      emulator: this.toEmulator(
        this.lastAvds.find((a) => a.name === avdName) ?? avdFromConfig(avdName, {}),
        undefined,
      ),
    });
    return { ok: true };
  }

  /**
   * Called at quit. Off by default: an emulator is a window the user can close themselves, and
   * killing one that took two minutes to boot is a rude way to say goodbye.
   */
  async stopAllOnQuit(enabled: boolean): Promise<void> {
    if (!enabled) return;
    const ours = [...this.running.values()].filter((record) => record.child !== null);
    await Promise.all(
      ours.map(async (record) => {
        try {
          await this.deps.emuKill(record.serial);
        } catch {
          this.deps.killTree(record.pid as number);
        }
      }),
    );
  }

  dispose(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}
