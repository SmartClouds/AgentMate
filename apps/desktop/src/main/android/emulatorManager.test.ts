import type { AndroidEvent, AvdSummary } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AndroidEmulatorManager } from './emulatorManager';

/**
 * The lifecycle manager, driven by fakes rather than a real SDK.
 *
 * The behaviours that matter are the ones that are hard to see by hand: that the console port is
 * chosen so the serial is known before the emulator exists, that the boot stages follow what the
 * device actually reports, that an emulator started outside Runova is adopted rather than
 * ignored, and that stopping falls back to killing the process when the console will not.
 */

function avd(name: string): AvdSummary {
  return {
    name,
    displayName: name,
    device: 'pixel_7',
    manufacturer: 'Google',
    api: 34,
    tag: 'google_apis',
    abi: 'x86_64',
    playStore: false,
    ramMb: 2048,
    storageMb: 6144,
    gpuMode: 'auto',
    systemImageDir: null,
    path: null,
  };
}

/** A scriptable stand-in for the device world the manager talks to. */
class FakeWorld {
  attached = new Map<string, 'device' | 'offline'>();
  props = new Map<string, Record<string, string>>();
  killed: string[] = [];
  treeKills: number[] = [];
  launched: { args: string[]; pid: number }[] = [];
  avdBySerial = new Map<string, string>();
  emuKillWorks = true;
  nextPid = 1000;

  /** Brings a serial up to the state a booted emulator reports. */
  boot(serial: string, avdName: string): void {
    this.attached.set(serial, 'device');
    this.avdBySerial.set(serial, avdName);
    this.props.set(serial, { 'sys.boot_completed': '1', 'init.svc.bootanim': 'stopped' });
  }

  deps() {
    return {
      listAttached: async () => ({
        emulators: [...this.attached.entries()].map(([serial, state]) => ({ serial, state })),
        physical: [],
      }),
      resolveAvdNames: async (serials: string[]) =>
        new Map(
          serials.flatMap((s) => {
            const name = this.avdBySerial.get(s);
            return name ? ([[s, name]] as [string, string][]) : [];
          }),
        ),
      getProp: async (serial: string, prop: string) => this.props.get(serial)?.[prop] ?? '',
      emuKill: async (serial: string) => {
        if (!this.emuKillWorks) throw new Error('console refused');
        this.killed.push(serial);
        this.attached.delete(serial);
      },
      launch: (args: string[]) => {
        const pid = this.nextPid++;
        this.launched.push({ args, pid });
        return { pid, kill: () => this.treeKills.push(pid) };
      },
      killTree: (pid: number) => {
        this.treeKills.push(pid);
      },
    };
  }
}

let world: FakeWorld;
let events: AndroidEvent[];

function makeManager(avds: AvdSummary[], overrides: Record<string, unknown> = {}) {
  return new AndroidEmulatorManager({
    ...world.deps(),
    listAvds: async () => ({ avds, broken: [] }),
    emit: (event: AndroidEvent) => events.push(event),
    pollMs: 10,
    bootTimeoutMs: 5000,
    ...overrides,
  });
}

beforeEach(() => {
  world = new FakeWorld();
  events = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('snapshot', () => {
  it('lists a stopped AVD when nothing is attached', async () => {
    const manager = makeManager([avd('Pixel_7_API_34')]);

    const snapshot = await manager.snapshot();

    expect(snapshot.emulators).toHaveLength(1);
    expect(snapshot.emulators[0]).toMatchObject({ state: 'stopped', serial: null, progress: 0 });
  });

  it('adopts an emulator that was started outside Runova', async () => {
    world.boot('emulator-5554', 'Pixel_7_API_34');
    const manager = makeManager([avd('Pixel_7_API_34')]);

    const snapshot = await manager.snapshot();

    expect(snapshot.emulators[0]).toMatchObject({
      state: 'running',
      serial: 'emulator-5554',
      // We do not own its process, so there is no pid to sample and no tree to kill.
      adopted: true,
    });
  });

  it('shows an emulator whose AVD is not in the list, rather than dropping it', async () => {
    world.boot('emulator-5554', 'Some_Other_Avd');
    const manager = makeManager([]);

    const snapshot = await manager.snapshot();

    expect(snapshot.emulators.map((e) => e.avd.name)).toEqual(['Some_Other_Avd']);
  });
});

describe('start', () => {
  it('pins the console port so the serial is known before the emulator exists', async () => {
    const manager = makeManager([avd('Pixel_7_API_34')]);

    await manager.start('Pixel_7_API_34', {});

    expect(world.launched[0].args).toEqual(['-avd', 'Pixel_7_API_34', '-port', '5554']);
    expect(manager.stateOf('Pixel_7_API_34')).toMatchObject({
      state: 'launching',
      serial: 'emulator-5554',
    });
  });

  it('skips a port another emulator already holds', async () => {
    world.boot('emulator-5554', 'Other');
    const manager = makeManager([avd('Pixel_7_API_34')]);
    await manager.snapshot();

    await manager.start('Pixel_7_API_34', {});

    expect(world.launched[0].args).toContain('5556');
  });

  it('refuses to start the same AVD twice', async () => {
    const manager = makeManager([avd('Pixel_7_API_34')]);
    await manager.start('Pixel_7_API_34', {});

    const second = await manager.start('Pixel_7_API_34', {});

    // A second emulator on the same AVD fails on a lock file, so it is refused up front.
    expect(second.ok).toBe(false);
    expect(world.launched).toHaveLength(1);
  });

  it('passes cold boot and wipe through to the command line', async () => {
    const manager = makeManager([avd('A'), avd('B')]);

    await manager.start('A', { coldBoot: true });
    await manager.start('B', { wipeData: true });

    expect(world.launched[0].args).toContain('-no-snapshot-load');
    expect(world.launched[1].args).toContain('-wipe-data');
  });

  it('walks the boot stages as the device reports them', async () => {
    const manager = makeManager([avd('Pixel_7_API_34')]);
    await manager.start('Pixel_7_API_34', {});
    expect(manager.stateOf('Pixel_7_API_34').state).toBe('launching');

    // The serial shows up but the device is not ready yet.
    world.attached.set('emulator-5554', 'offline');
    await vi.advanceTimersByTimeAsync(20);
    expect(manager.stateOf('Pixel_7_API_34').state).toBe('connecting');

    // adb can reach it, but Android is still coming up.
    world.attached.set('emulator-5554', 'device');
    world.props.set('emulator-5554', { 'sys.boot_completed': '0' });
    await vi.advanceTimersByTimeAsync(20);
    expect(manager.stateOf('Pixel_7_API_34').state).toBe('booting');

    // Booted, but the boot animation is still playing.
    world.props.set('emulator-5554', {
      'sys.boot_completed': '1',
      'init.svc.bootanim': 'running',
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(manager.stateOf('Pixel_7_API_34').state).toBe('finishing');

    world.props.set('emulator-5554', {
      'sys.boot_completed': '1',
      'init.svc.bootanim': 'stopped',
    });
    await vi.advanceTimersByTimeAsync(20);
    const ready = manager.stateOf('Pixel_7_API_34');
    expect(ready.state).toBe('running');
    expect(ready.progress).toBe(100);
  });

  it('gives up after the boot timeout instead of spinning forever', async () => {
    const manager = makeManager([avd('Pixel_7_API_34')], { bootTimeoutMs: 100 });
    await manager.start('Pixel_7_API_34', {});

    await vi.advanceTimersByTimeAsync(200);

    const state = manager.stateOf('Pixel_7_API_34');
    expect(state.state).toBe('failed');
    expect(state.error).toBeTruthy();
  });

  it('reports each state change once, and says nothing when nothing changed', async () => {
    const manager = makeManager([avd('Pixel_7_API_34')]);
    await manager.start('Pixel_7_API_34', {});
    events.length = 0;

    await vi.advanceTimersByTimeAsync(50);
    // Several polls, all seeing the same thing.
    expect(events.filter((e) => e.kind === 'emulator')).toHaveLength(0);

    world.boot('emulator-5554', 'Pixel_7_API_34');
    await vi.advanceTimersByTimeAsync(20);
    expect(events.filter((e) => e.kind === 'emulator').length).toBeGreaterThan(0);
  });
});

describe('stop', () => {
  it('asks the console first, so the emulator can save its snapshot', async () => {
    world.boot('emulator-5554', 'Pixel_7_API_34');
    const manager = makeManager([avd('Pixel_7_API_34')]);
    await manager.snapshot();

    await manager.stop('emulator-5554');

    expect(world.killed).toEqual(['emulator-5554']);
    expect(world.treeKills).toEqual([]);
  });

  it('kills the process tree when the console will not answer', async () => {
    const manager = makeManager([avd('Pixel_7_API_34')]);
    await manager.start('Pixel_7_API_34', {});
    world.boot('emulator-5554', 'Pixel_7_API_34');
    await vi.advanceTimersByTimeAsync(20);

    world.emuKillWorks = false;
    const stopping = manager.stop('emulator-5554');
    await vi.advanceTimersByTimeAsync(30_000);
    await stopping;

    // `emu kill` fails silently on an unauthorized device, so this fallback is what makes Stop work.
    expect(world.treeKills).toEqual([1000]);
  });

  it('cannot force stop an adopted emulator, because there is no pid we own', async () => {
    world.boot('emulator-5554', 'Pixel_7_API_34');
    const manager = makeManager([avd('Pixel_7_API_34')]);
    await manager.snapshot();
    world.emuKillWorks = false;

    const result = await manager.stop('emulator-5554');

    expect(result.ok).toBe(false);
    expect(world.treeKills).toEqual([]);
  });
});

describe('cancelBoot', () => {
  it('kills the emulator we started and puts the card back to stopped', async () => {
    const manager = makeManager([avd('Pixel_7_API_34')]);
    await manager.start('Pixel_7_API_34', {});

    await manager.cancelBoot('Pixel_7_API_34');

    expect(world.treeKills).toEqual([1000]);
    expect(manager.stateOf('Pixel_7_API_34').state).toBe('stopped');
  });
});

describe('quit', () => {
  it('leaves emulators running by default', async () => {
    world.boot('emulator-5554', 'Pixel_7_API_34');
    const manager = makeManager([avd('Pixel_7_API_34')]);
    await manager.snapshot();

    await manager.stopAllOnQuit(false);

    expect(world.killed).toEqual([]);
  });

  it('stops them when the setting asks for it', async () => {
    const manager = makeManager([avd('Pixel_7_API_34')]);
    await manager.start('Pixel_7_API_34', {});
    world.boot('emulator-5554', 'Pixel_7_API_34');
    await vi.advanceTimersByTimeAsync(20);

    await manager.stopAllOnQuit(true);

    expect(world.killed).toEqual(['emulator-5554']);
  });
});
