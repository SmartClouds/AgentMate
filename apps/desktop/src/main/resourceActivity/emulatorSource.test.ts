import { describe, expect, it, vi } from 'vitest';
import { createEmulatorSource, type EmulatorSourceDeps, type TreeUsage } from './emulatorSource';

/**
 * The emulator reader has two jobs that go wrong quietly: never touching adb when no server is
 * running (asking adb would start one), and finding the process behind an emulator Runova did
 * not launch. Both are exercised through fakes here.
 */

function tree(overrides: Partial<TreeUsage> = {}): TreeUsage {
  return { found: true, cpuPercent: 5, memBytes: 2000, ...overrides };
}

function setup(overrides: Partial<EmulatorSourceDeps> = {}) {
  const deps = {
    adbServerListening: vi.fn(async () => true),
    listOnlineEmulators: vi.fn(async (): Promise<string[] | null> => ['emulator-5554']),
    resolveAvdNames: vi.fn(async (serials: string[]) => {
      const names = new Map<string, string>();
      for (const serial of serials) names.set(serial, `avd-${serial.split('-')[1]}`);
      return names;
    }),
    launchedPids: vi.fn(() => new Map<string, number>()),
    listeningPorts: vi.fn(async () => new Map<number, number[]>([[4242, [5554, 5555]]])),
    sampleTrees: vi.fn(async (rootPids: number[]) => ({
      available: true,
      cpuReady: true,
      trees: new Map(rootPids.map((pid) => [pid, tree()])),
    })),
    cpuCount: 8,
    ...overrides,
  };
  return { deps, read: createEmulatorSource(deps) };
}

describe('emulator source', () => {
  it('does not ask adb anything when no adb server is listening', async () => {
    const { deps, read } = setup({ adbServerListening: vi.fn(async () => false) });

    await expect(read()).resolves.toBeNull();

    expect(deps.listOnlineEmulators).not.toHaveBeenCalled();
    expect(deps.sampleTrees).not.toHaveBeenCalled();
  });

  it('is unavailable when adb cannot be run', async () => {
    const { read } = setup({ listOnlineEmulators: vi.fn(async () => null) });
    await expect(read()).resolves.toBeNull();
  });

  it('is an empty list, not unavailable, when adb runs and no emulator is up', async () => {
    const { deps, read } = setup({ listOnlineEmulators: vi.fn(async () => []) });

    await expect(read()).resolves.toEqual([]);

    expect(deps.sampleTrees).not.toHaveBeenCalled();
  });

  it('finds an emulator started elsewhere through the console port it listens on', async () => {
    const { deps, read } = setup();

    const [only] = (await read()) ?? [];

    expect(deps.sampleTrees).toHaveBeenCalledWith([4242]);
    expect(only).toMatchObject({
      serial: 'emulator-5554',
      avdName: 'avd-5554',
      memBytes: 2000,
      measurable: true,
    });
  });

  it('turns the process tree share of all cores into cores', async () => {
    const { read } = setup({
      cpuCount: 8,
      sampleTrees: vi.fn(async () => ({
        available: true,
        cpuReady: true,
        trees: new Map([[4242, tree({ cpuPercent: 10 })]]),
      })),
    });

    const [only] = (await read()) ?? [];

    // 10% of 8 cores is 80% of one core.
    expect(only?.cpuPercent).toBeCloseTo(80);
  });

  it('reports CPU as unknown on the first sample, when there is nothing to compare against', async () => {
    const { read } = setup({
      sampleTrees: vi.fn(async () => ({
        available: true,
        cpuReady: false,
        trees: new Map([[4242, tree()]]),
      })),
    });

    const [only] = (await read()) ?? [];

    expect(only).toMatchObject({ cpuPercent: null, measurable: true });
  });

  it('prefers the pid Runova recorded and skips the port lookup', async () => {
    const { deps, read } = setup({
      launchedPids: vi.fn(() => new Map([['emulator-5554', 999]])),
    });

    await read();

    expect(deps.listeningPorts).not.toHaveBeenCalled();
    expect(deps.sampleTrees).toHaveBeenCalledWith([999]);
  });

  it('remembers a pid found by port instead of looking again every reading', async () => {
    const { deps, read } = setup();

    await read();
    await read();
    await read();

    expect(deps.listeningPorts).toHaveBeenCalledTimes(1);
    expect(deps.resolveAvdNames).toHaveBeenCalledTimes(1);
  });

  it('cannot measure an emulator no process owns the port of', async () => {
    const { deps, read } = setup({ listeningPorts: vi.fn(async () => new Map()) });

    const [only] = (await read()) ?? [];

    expect(only).toMatchObject({ measurable: false, cpuPercent: null, memBytes: null });
    expect(deps.sampleTrees).not.toHaveBeenCalled();
  });

  it('looks the process up again when the remembered one is gone', async () => {
    const trees = new Map<number, TreeUsage>([[4242, tree({ found: false })]]);
    const { deps, read } = setup({
      sampleTrees: vi.fn(async () => ({ available: true, cpuReady: true, trees })),
    });

    const [first] = (await read()) ?? [];
    expect(first?.measurable).toBe(false);

    trees.set(4242, tree());
    const [second] = (await read()) ?? [];
    expect(second?.measurable).toBe(true);
    expect(deps.listeningPorts).toHaveBeenCalledTimes(2);
  });

  it('cannot measure anything when the process list is unreadable', async () => {
    const { read } = setup({
      sampleTrees: vi.fn(async () => ({ available: false, cpuReady: false, trees: new Map() })),
    });

    const [only] = (await read()) ?? [];

    expect(only?.measurable).toBe(false);
  });

  it('leaves out an emulator that has not answered its console yet', async () => {
    const { read } = setup({
      listOnlineEmulators: vi.fn(async () => ['emulator-5554', 'emulator-5556']),
      resolveAvdNames: vi.fn(async () => new Map([['emulator-5556', 'Pixel_Tablet']])),
      listeningPorts: vi.fn(async () => new Map([[7, [5556, 5557]]])),
    });

    const list = (await read()) ?? [];

    expect(list.map((one) => one.avdName)).toEqual(['Pixel_Tablet']);
  });

  it('asks again for the name of one that was still booting', async () => {
    const resolveAvdNames = vi
      .fn<EmulatorSourceDeps['resolveAvdNames']>()
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([['emulator-5554', 'Pixel_7']]));
    const { read } = setup({ resolveAvdNames });

    expect(await read()).toEqual([]);
    const [only] = (await read()) ?? [];

    expect(only?.avdName).toBe('Pixel_7');
    expect(resolveAvdNames).toHaveBeenCalledTimes(2);
  });

  it('forgets what it learned about an emulator that went away', async () => {
    const online = ['emulator-5554'];
    const { deps, read } = setup({ listOnlineEmulators: vi.fn(async () => [...online]) });

    await read();
    online.length = 0;
    await read();
    online.push('emulator-5554');
    await read();

    // A new emulator on the same port is a different process, so it is resolved from scratch.
    expect(deps.resolveAvdNames).toHaveBeenCalledTimes(2);
    expect(deps.listeningPorts).toHaveBeenCalledTimes(2);
  });

  it('measures several emulators in one process-list read', async () => {
    const { deps, read } = setup({
      listOnlineEmulators: vi.fn(async () => ['emulator-5554', 'emulator-5556']),
      listeningPorts: vi.fn(
        async () =>
          new Map([
            [11, [5554, 5555]],
            [22, [5556, 5557]],
          ]),
      ),
    });

    const list = (await read()) ?? [];

    expect(deps.sampleTrees).toHaveBeenCalledTimes(1);
    expect(deps.sampleTrees).toHaveBeenCalledWith([11, 22]);
    expect(list.map((one) => one.measurable)).toEqual([true, true]);
  });
});
