import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TERMINAL_DEFAULT_HEIGHT,
  terminalMaxHeight,
  useTerminalStore,
} from '@/stores/terminalStore';
import { type FakeBridge, installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { closeSftpDock, DOCK_MIN_HEIGHT, dockDrawerHeight, openSftpDock } from './dock';

/** The file manager docked as a terminal drawer tab (E25 F6): one tab per server. */

let bridge: FakeBridge;

function store() {
  return useTerminalStore.getState();
}

function sftpTabs() {
  return store().sessions.filter((s) => s.kind === 'sftp');
}

const innerHeight = window.innerHeight;

beforeEach(() => {
  bridge = installRunovaBridge({ platform: 'win32' });
  useTerminalStore.setState({
    isOpen: false,
    isMaximized: false,
    drawerHeight: TERMINAL_DEFAULT_HEIGHT,
    sessions: [],
    activeSessionId: null,
  });
});

afterEach(() => {
  window.innerHeight = innerHeight;
  document.body.innerHTML = '';
});

/** The page area with the drawer in it, as AppShell lays it out, at this height. */
function layOutPageArea(height: number): void {
  const area = document.createElement('div');
  Object.defineProperty(area, 'clientHeight', { value: height });
  const drawer = document.createElement('section');
  drawer.setAttribute('data-terminal-drawer', '');
  area.append(drawer);
  document.body.append(area);
}

describe('openSftpDock', () => {
  it('opens the drawer on a new tab named after the server', () => {
    openSftpDock('srv-1', 'build box');

    expect(store().isOpen).toBe(true);
    expect(sftpTabs()).toEqual([
      // Not just the nickname: the server's SSH tab already goes by that.
      expect.objectContaining({ title: 'Files: build box', kind: 'sftp', sftpServerId: 'srv-1' }),
    ]);
    expect(store().activeSessionId).toBe(sftpTabs()[0]?.id);
  });

  it('goes back to the tab a server already has instead of adding a second one', () => {
    openSftpDock('srv-1', 'build box');
    const first = store().activeSessionId;
    const shell = store().openDefaultSession();
    store().closeDrawer();

    openSftpDock('srv-1', 'build box');

    expect(sftpTabs()).toHaveLength(1);
    expect(store().activeSessionId).toBe(first);
    expect(store().activeSessionId).not.toBe(shell);
    expect(store().isOpen).toBe(true);
  });

  it('gives each server a tab of its own', () => {
    openSftpDock('srv-1', 'build box');
    openSftpDock('srv-2', 'web');

    expect(sftpTabs().map((s) => s.sftpServerId)).toEqual(['srv-1', 'srv-2']);
    expect(store().activeSessionId).toBe(sftpTabs()[1]?.id);
  });

  it('is not fooled by an SSH tab on the same server', () => {
    store().openSession({ title: 'build box', kind: 'ssh', sshServerId: 'srv-1' });
    openSftpDock('srv-1', 'build box');
    expect(sftpTabs()).toHaveLength(1);
    expect(store().sessions).toHaveLength(2);
  });
});

describe('closeSftpDock', () => {
  it("drops the server's tab and ends nothing", () => {
    const shell = store().openDefaultSession();
    openSftpDock('srv-1', 'build box');
    openSftpDock('srv-2', 'web');

    closeSftpDock('srv-1');

    expect(sftpTabs().map((s) => s.sftpServerId)).toEqual(['srv-2']);
    expect(store().sessions.some((s) => s.id === shell)).toBe(true);
    expect(() => bridge.$fn('terminal.kill')).toThrow();
    expect(() => bridge.$fn('ssh.kill')).toThrow();
  });

  it('does nothing for a server with no tab', () => {
    const shell = store().openDefaultSession();
    closeSftpDock('srv-9');
    expect(store().sessions.map((s) => s.id)).toEqual([shell]);
  });
});

describe('dockDrawerHeight', () => {
  it('asks for 45% of the window', () => {
    expect(dockDrawerHeight(288, 1000, 760)).toBe(450);
  });

  it('never asks for less than enough to list the files', () => {
    expect(dockDrawerHeight(288, 700, 460)).toBe(DOCK_MIN_HEIGHT);
  });

  it('stays inside the most the drawer can take, even under that', () => {
    expect(dockDrawerHeight(200, 600, 360)).toBe(360);
  });

  it('leaves a drawer the user already made taller alone', () => {
    expect(dockDrawerHeight(600, 1000, 760)).toBe(600);
    expect(dockDrawerHeight(450, 1000, 760)).toBe(450);
  });
});

describe('openSftpDock, the drawer height', () => {
  it('raises a short drawer so the files have room, from the page area it sits in', () => {
    window.innerHeight = 1100;
    layOutPageArea(900);
    openSftpDock('srv-1', 'build box');
    // 45% of the window; the page area allows up to 900 - 240.
    expect(store().drawerHeight).toBe(495);
    expect(terminalMaxHeight(900)).toBe(660);
  });

  it('keeps under the page area room on a short window', () => {
    window.innerHeight = 640;
    layOutPageArea(560);
    openSftpDock('srv-1', 'build box');
    expect(store().drawerHeight).toBe(320);
  });

  it('measures the window when the drawer is not laid out', () => {
    window.innerHeight = 1000;
    openSftpDock('srv-1', 'build box');
    expect(store().drawerHeight).toBe(450);
  });

  it('also raises it when going back to the tab a server already has', () => {
    window.innerHeight = 1000;
    openSftpDock('srv-1', 'build box');
    store().setDrawerHeight(200);
    openSftpDock('srv-1', 'build box');
    expect(store().drawerHeight).toBe(450);
  });

  it('keeps a taller drawer as the user left it', () => {
    window.innerHeight = 1000;
    store().setDrawerHeight(620);
    openSftpDock('srv-1', 'build box');
    expect(store().drawerHeight).toBe(620);
  });
});

describe('closeSftpDock, the drawer as it was', () => {
  it('puts back the height and closes the drawer it opened when no tab is left', () => {
    window.innerHeight = 1000;
    openSftpDock('srv-1', 'build box');
    expect(store().drawerHeight).toBe(450);

    closeSftpDock('srv-1');
    expect(store().drawerHeight).toBe(TERMINAL_DEFAULT_HEIGHT);
    expect(store().isOpen).toBe(false);
  });

  it('leaves an open drawer open on the shells it had', () => {
    window.innerHeight = 1000;
    store().openDefaultSession();
    openSftpDock('srv-1', 'build box');
    closeSftpDock('srv-1');
    expect(store().drawerHeight).toBe(TERMINAL_DEFAULT_HEIGHT);
    expect(store().isOpen).toBe(true);
  });

  it('shuts a drawer that was shut before, even with shells in it', () => {
    window.innerHeight = 1000;
    store().openDefaultSession();
    store().closeDrawer();
    openSftpDock('srv-1', 'build box');
    expect(store().isOpen).toBe(true);
    closeSftpDock('srv-1');
    expect(store().isOpen).toBe(false);
    expect(store().sessions).toHaveLength(1);
  });

  it('keeps a height the user chose while the files were docked', () => {
    window.innerHeight = 1000;
    store().openDefaultSession();
    openSftpDock('srv-1', 'build box');
    store().setDrawerHeight(520);
    closeSftpDock('srv-1');
    expect(store().drawerHeight).toBe(520);
  });

  it('waits for the last docked server before putting anything back', () => {
    window.innerHeight = 1000;
    openSftpDock('srv-1', 'build box');
    openSftpDock('srv-2', 'web');
    closeSftpDock('srv-1');
    expect(store().drawerHeight).toBe(450);
    expect(store().isOpen).toBe(true);
    closeSftpDock('srv-2');
    expect(store().drawerHeight).toBe(TERMINAL_DEFAULT_HEIGHT);
    expect(store().isOpen).toBe(false);
  });

  it('closes an empty drawer, and leaves it unmaximized, for a tab it did not open', () => {
    store().openSession({ title: 'Files: web', kind: 'sftp', sftpServerId: 'srv-2' });
    store().setMaximized(true);
    closeSftpDock('srv-2');
    expect(store()).toMatchObject({ isOpen: false, isMaximized: false });
  });
});
