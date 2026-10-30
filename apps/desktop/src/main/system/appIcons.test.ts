import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withPlatform } from '../../test/main/fixtures';

/**
 * The status bar's "Busiest apps" showed the blank program icon for Runova itself, the Claude Code
 * CLI and the Visual Studio installer's helpers, because Electron's app.getFileIcon returns that
 * placeholder for some exes that do have an icon. Services and elevated processes got no icon at
 * all, since Get-Process has no path for them. On Windows the icons now come from one PowerShell
 * call that finds each app's exe and extracts its icon. These tests pin down what that call is
 * asked and how its answer is used.
 */

const scripts = vi.hoisted(() => [] as string[]);
const answers = vi.hoisted(() => ({ next: null as unknown }));

vi.mock('./processTree', () => ({
  asArray: <T>(parsed: T | T[] | null | undefined): T[] =>
    parsed == null ? [] : Array.isArray(parsed) ? parsed : [parsed],
  runPowerShellJson: async (script: string) => {
    scripts.push(script);
    return answers.next;
  },
}));

let iconsForApps: typeof import('./appIcons').iconsForApps;

beforeEach(async () => {
  scripts.length = 0;
  answers.next = null;
  // The icon caches live in the module, so each test starts from a fresh copy.
  vi.resetModules();
  ({ iconsForApps } = await import('./appIcons'));
});

const RUNOVA = 'C:\\Programs\\Runova\\Runova.exe';

function onWindows<T>(work: () => Promise<T>): Promise<T> {
  return withPlatform('win32', work);
}

describe('iconsForApps on Windows', () => {
  it('uses the icon of whichever pid in the group Windows found an exe for', async () => {
    answers.next = {
      processes: [
        { pid: 40, path: null },
        { pid: 41, path: RUNOVA },
      ],
      icons: { path: RUNOVA, png: 'AAAA' },
    };
    const icons = await onWindows(() => iconsForApps([{ name: 'Runova', pids: [40, 41] }]));
    expect(icons).toEqual(['data:image/png;base64,AAAA']);
  });

  it('asks about every app in one PowerShell call', async () => {
    answers.next = { processes: [], icons: [] };
    await onWindows(() =>
      iconsForApps([
        { name: 'node', pids: [1, 2] },
        { name: 'msedge', pids: [3] },
      ]),
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('$wanted = @(1,2,3)');
  });

  it('does not start PowerShell again once every exe is known', async () => {
    answers.next = {
      processes: [{ pid: 41, path: RUNOVA }],
      icons: [{ path: RUNOVA, png: 'AAAA' }],
    };
    await onWindows(() => iconsForApps([{ name: 'Runova', pids: [41] }]));
    answers.next = null;
    const icons = await onWindows(() => iconsForApps([{ name: 'Runova', pids: [41, 42] }]));
    expect(scripts).toHaveLength(1);
    expect(icons).toEqual(['data:image/png;base64,AAAA']);
  });

  it('stops asking about a process whose exe Windows would not reveal', async () => {
    answers.next = { processes: [{ pid: 4, path: null }], icons: [] };
    const first = await onWindows(() => iconsForApps([{ name: 'System', pids: [4] }]));
    const second = await onWindows(() => iconsForApps([{ name: 'System', pids: [4] }]));
    expect(first).toEqual([undefined]);
    expect(second).toEqual([undefined]);
    expect(scripts).toHaveLength(1);
  });

  it('asks again after a PowerShell call that failed', async () => {
    await onWindows(() => iconsForApps([{ name: 'Runova', pids: [41] }]));
    answers.next = {
      processes: [{ pid: 41, path: RUNOVA }],
      icons: [{ path: RUNOVA, png: 'AAAA' }],
    };
    const icons = await onWindows(() => iconsForApps([{ name: 'Runova', pids: [41] }]));
    expect(scripts).toHaveLength(2);
    expect(icons).toEqual(['data:image/png;base64,AAAA']);
  });

  it('leaves the icon out for an exe that has none', async () => {
    answers.next = { processes: [{ pid: 41, path: RUNOVA }], icons: [{ path: RUNOVA, png: null }] };
    const icons = await onWindows(() => iconsForApps([{ name: 'Runova', pids: [41] }]));
    expect(icons).toEqual([undefined]);
  });

  it('never puts a process name into the script as text', async () => {
    const name = "evil'; Remove-Item C:\\ -Recurse; '";
    await onWindows(() => iconsForApps([{ name, pids: [7] }]));
    expect(scripts[0]).not.toContain('Remove-Item');
    expect(scripts[0]).toContain(Buffer.from(JSON.stringify([name])).toString('base64'));
  });

  it('skips pids that are not real and only tries the heaviest few of a big group', async () => {
    const pids = [0, -1, 1.5, ...Array.from({ length: 20 }, (_, i) => 100 + i)];
    await onWindows(() => iconsForApps([{ name: 'svchost', pids }]));
    expect(scripts[0]).toContain('$wanted = @(100,101,102,103,104,105,106,107)');
  });
});
