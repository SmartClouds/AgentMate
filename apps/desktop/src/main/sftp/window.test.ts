import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { SftpSessionInfo } from '../../shared/sftpTypes';
import { electronState, FakeBrowserWindow } from '../../test/main/electronMock';
import { withPlatform } from '../../test/main/fixtures';

/**
 * The SFTP file manager's pop-out windows (E25, F2): one per session, let into the session as
 * another owner before the page loads, taken out again when the window closes, and with window
 * controls that only ever act on the window that asks.
 */

const main = vi.hoisted(() => ({
  window: null as unknown,
  focusMainWindow: vi.fn(),
}));

vi.mock('../mainWindow', () => ({
  getMainWindow: () => main.window,
  focusMainWindow: main.focusMainWindow,
}));

type Listener = (...args: unknown[]) => unknown;
type OpenHandler = (details: { url: string }) => { action: string };

/** The mock's webContents ignores listeners; the pop-out's are fired here. */
vi.mock('electron', async (importOriginal) => {
  const electron = await importOriginal<{ BrowserWindow: typeof FakeBrowserWindow }>();
  class ListeningWindow extends electron.BrowserWindow {
    constructor(options: Record<string, unknown> = {}) {
      super(options);
      const listeners = new Map<string, Listener[]>();
      const add = (event: string, listener: Listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      };
      Object.assign(this.webContents, {
        on: add,
        once: add,
        fire: (event: string, ...args: unknown[]) => {
          for (const listener of listeners.get(event) ?? []) listener(...args);
        },
        setWindowOpenHandler: (handler: OpenHandler) => {
          Object.assign(this.webContents, { openHandler: handler });
        },
      });
    }
  }
  return { ...electron, BrowserWindow: ListeningWindow };
});

/** The pop-out's page, with what window.ts listens for on it. */
function page(window: FakeBrowserWindow) {
  return window.webContents as unknown as {
    id: number;
    fire(event: string, ...args: unknown[]): void;
    openHandler?: OpenHandler;
  };
}

const {
  closeAllSftpWindows,
  isSftpWindow,
  openSftpWindow,
  sftpBackToMain,
  sftpLinkedOwners,
  sftpWindowControl,
  sftpWindowState,
} = await import('./window');
const { applyWindowTheme } = await import('../windowGlass');

function info(sessionId: string, serverId = 'srv-1'): SftpSessionInfo {
  return {
    sessionId,
    serverId,
    nickname: 'web',
    host: 'web.example.com',
    port: 22,
    username: 'deploy',
    home: '/home/deploy',
  };
}

function owners() {
  return {
    addOwner: vi.fn(),
    adoptSessions: vi.fn(),
    dropOwner: vi.fn(async () => undefined),
  };
}

function popOut(sessionId: string, service = owners(), serverId = 'srv-1') {
  const window = openSftpWindow(service, info(sessionId, serverId)) as unknown as FakeBrowserWindow;
  return { window, service };
}

beforeEach(() => {
  main.window = new FakeBrowserWindow();
  main.focusMainWindow.mockClear();
  applyWindowTheme('system');
});

afterEach(() => {
  closeAllSftpWindows();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('opening a pop-out', () => {
  it('lets the window into the session before its page loads, on the pop-out route', () => {
    applyWindowTheme('dark');
    const loadFile = vi.spyOn(FakeBrowserWindow.prototype, 'loadFile');

    const { window, service } = popOut('sess-1', owners(), 'srv 1');

    expect(service.addOwner).toHaveBeenCalledWith('sess-1', window.webContents.id);
    expect(loadFile).toHaveBeenCalledOnce();
    expect(service.addOwner.mock.invocationCallOrder[0]).toBeLessThan(
      loadFile.mock.invocationCallOrder[0],
    );
    expect((loadFile.mock.calls[0] as unknown[])[1]).toEqual({
      hash: '/sftp-window?server=srv+1&theme=dark',
    });
    expect(window.options).toMatchObject({
      width: 1200,
      height: 780,
      show: false,
      title: 'web - Files',
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    expect(isSftpWindow(window.webContents as never)).toBe(true);
  });

  it('carries the folders to open at in the route, encoded', () => {
    const loadFile = vi.spyOn(FakeBrowserWindow.prototype, 'loadFile');

    openSftpWindow(owners(), info('sess-10'), {
      remotePath: '/srv/my site',
      localPath: 'C:\\Users\\me & you',
    });

    const { hash } = (loadFile.mock.calls[0] as unknown[])[1] as { hash: string };
    expect(hash).toBe(
      '/sftp-window?server=srv-1&theme=system&remote=%2Fsrv%2Fmy+site&local=C%3A%5CUsers%5Cme+%26+you',
    );
    const query = new URLSearchParams(hash.slice(hash.indexOf('?')));
    expect(query.get('remote')).toBe('/srv/my site');
    expect(query.get('local')).toBe('C:\\Users\\me & you');
  });

  it('leaves out the folders it was not given', () => {
    const loadFile = vi.spyOn(FakeBrowserWindow.prototype, 'loadFile');

    openSftpWindow(owners(), info('sess-11'), { localPath: '/home/me' });

    expect((loadFile.mock.calls[0] as unknown[])[1]).toEqual({
      hash: '/sftp-window?server=srv-1&theme=system&local=%2Fhome%2Fme',
    });
  });

  it('loads from the dev server when there is one', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    const loadURL = vi.spyOn(FakeBrowserWindow.prototype, 'loadURL');

    popOut('sess-2');

    expect(loadURL).toHaveBeenCalledWith(
      'http://localhost:5173#/sftp-window?server=srv-1&theme=system',
    );
  });

  it('shows the window once it is ready, and keeps its title on the taskbar', () => {
    const { window } = popOut('sess-3');
    const preventDefault = vi.fn();

    window.emit('ready-to-show');
    window.emit('page-title-updated', { preventDefault });

    expect(window.isVisible()).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('stays on the app page: navigations elsewhere are stopped, the app page is let through', async () => {
    const { pathToFileURL } = await import('node:url');
    const { join } = await import('node:path');
    const { window } = popOut('sess-nav');
    const appPage = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
    const navigate = (url: string) => {
      const event = { preventDefault: vi.fn() };
      page(window).fire('will-navigate', event, url);
      return event.preventDefault;
    };

    // A file dropped on the window would otherwise replace the page and keep its privileges.
    expect(navigate('file:///C:/Users/me/notes.txt')).toHaveBeenCalled();
    expect(navigate('https://example.com/')).toHaveBeenCalled();
    expect(navigate('not a url')).toHaveBeenCalled();
    expect(navigate(`${appPage}#/sftp-window?server=srv-1`)).not.toHaveBeenCalled();

    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    expect(navigate('http://localhost:5173/#/sftp-window')).not.toHaveBeenCalled();
    expect(navigate('http://localhost:5174/')).toHaveBeenCalled();
  });

  it('opens no window of its own: web links go to the browser, anything else nowhere', () => {
    const { window } = popOut('sess-open');
    const handler = page(window).openHandler as OpenHandler;
    const opened = electronState.openedExternal.length;

    expect(handler({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'http://example.com/' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'file:///C:/Windows/System32/calc.exe' })).toEqual({ action: 'deny' });

    expect(electronState.openedExternal.slice(opened)).toEqual([
      'https://example.com/docs',
      'http://example.com/',
    ]);
  });

  it('focuses the open window of the session instead of opening a second one', () => {
    const { window, service } = popOut('sess-4');
    vi.spyOn(window, 'isMinimized').mockReturnValue(true);
    const restore = vi.spyOn(window, 'restore');
    const focus = vi.spyOn(window, 'focus');
    const count = FakeBrowserWindow.instances.length;

    const loadFile = vi.spyOn(FakeBrowserWindow.prototype, 'loadFile');

    // Folders asked for now do not move a window already showing the session.
    const again = openSftpWindow(service, info('sess-4'), { remotePath: '/srv' });

    expect(again).toBe(window);
    expect(FakeBrowserWindow.instances).toHaveLength(count);
    expect(restore).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    // Let in again, which changes nothing unless the window had left the session.
    expect(service.addOwner).toHaveBeenCalledTimes(2);
    expect(service.addOwner).toHaveBeenLastCalledWith('sess-4', window.webContents.id);
    expect(loadFile).not.toHaveBeenCalled();
  });

  it('opens no window when the session cannot take another owner', () => {
    const service = owners();
    service.addOwner.mockImplementation(() => {
      throw new Error('Unknown session. Open the server again.');
    });
    const loadFile = vi.spyOn(FakeBrowserWindow.prototype, 'loadFile');

    expect(() => openSftpWindow(service, info('sess-5'))).toThrow(/Unknown session/);

    const made = FakeBrowserWindow.instances.at(-1) as FakeBrowserWindow;
    expect(made.isDestroyed()).toBe(true);
    expect(isSftpWindow(made.webContents as never)).toBe(false);
    expect(loadFile).not.toHaveBeenCalled();
  });
});

describe('closing a pop-out', () => {
  it('hands its sessions to the main window, leaves them and forgets the window', () => {
    const { window, service } = popOut('sess-6');
    const ownerId = window.webContents.id;
    const mainId = (main.window as FakeBrowserWindow).webContents.id;

    window.close();

    expect(service.adoptSessions).toHaveBeenCalledWith(ownerId, mainId);
    expect(service.dropOwner).toHaveBeenCalledWith(ownerId);
    expect(service.adoptSessions.mock.invocationCallOrder[0]).toBeLessThan(
      service.dropOwner.mock.invocationCallOrder[0],
    );
    expect(isSftpWindow(window.webContents as never)).toBe(false);
    // The session's next pop-out is a new window.
    const next = openSftpWindow(service, info('sess-6'));
    expect(next).not.toBe(window);
  });

  it('closes with the main window, and then its sessions just end', async () => {
    const service = owners();
    // Off macOS: there the app keeps running and the pop-outs stay (the next test).
    const [first, second] = await withPlatform('linux', () => [
      popOut('sess-7', service).window,
      popOut('sess-8', service).window,
    ]);

    (main.window as FakeBrowserWindow).close();

    expect(first.isDestroyed()).toBe(true);
    expect(second.isDestroyed()).toBe(true);
    expect(service.adoptSessions).not.toHaveBeenCalled();
    expect(service.dropOwner).toHaveBeenCalledTimes(2);
  });

  it('stays open when the main window closes on macOS, where the app keeps running', async () => {
    const { window } = await withPlatform('darwin', () => popOut('sess-mac'));

    (main.window as FakeBrowserWindow).close();

    expect(window.isDestroyed()).toBe(false);
  });

  it('hands its sessions to the main window and closes when its page crashes', () => {
    const { window, service } = popOut('sess-crash');
    const mainId = (main.window as FakeBrowserWindow).webContents.id;

    page(window).fire('render-process-gone', {}, { reason: 'crashed' });

    expect(service.adoptSessions).toHaveBeenCalledWith(window.webContents.id, mainId);
    expect(window.isDestroyed()).toBe(true);
    expect(isSftpWindow(window.webContents as never)).toBe(false);
  });

  it('closes them all at quit', () => {
    const { window } = popOut('sess-9');

    closeAllSftpWindows();

    expect(window.isDestroyed()).toBe(true);
  });

  it('links the main window and the open pop-outs', () => {
    const mainId = (main.window as FakeBrowserWindow).webContents.id;
    const first = popOut('sess-link-1').window;
    const second = popOut('sess-link-2').window;
    second.close();

    expect(sftpLinkedOwners()).toEqual([mainId, first.webContents.id]);
    main.window = null;
    expect(sftpLinkedOwners()).toEqual([first.webContents.id]);
  });

  it('opens without the main window, too, and its sessions end with it', () => {
    main.window = null;

    const { window, service } = popOut('sess-10');
    window.close();

    expect(service.adoptSessions).not.toHaveBeenCalled();
    expect(service.dropOwner).toHaveBeenCalledWith(window.webContents.id);
  });
});

describe('window controls', () => {
  it('minimize, maximize, restore and close act on the asking window only', () => {
    const { window } = popOut('sess-11');
    const other = popOut('sess-12').window;
    const minimize = vi.spyOn(window, 'minimize');
    const maximize = vi.spyOn(window, 'maximize');
    const unmaximize = vi.spyOn(window, 'unmaximize');
    const otherMinimize = vi.spyOn(other, 'minimize');
    const sender = window.webContents as never;

    sftpWindowControl(sender, 'minimize');
    sftpWindowControl(sender, 'maximize');
    vi.spyOn(window, 'isMaximized').mockReturnValue(true);
    sftpWindowControl(sender, 'maximize');

    expect(minimize).toHaveBeenCalledOnce();
    expect(maximize).toHaveBeenCalledOnce();
    expect(unmaximize).toHaveBeenCalledOnce();
    expect(otherMinimize).not.toHaveBeenCalled();

    sftpWindowControl(sender, 'close');
    expect(window.isDestroyed()).toBe(true);
    expect(other.isDestroyed()).toBe(false);
  });

  it('leaves alone a window that is not a pop-out', () => {
    const stranger = main.window as FakeBrowserWindow;
    const minimize = vi.spyOn(stranger, 'minimize');

    sftpWindowControl(stranger.webContents as never, 'minimize');
    sftpBackToMain(owners(), stranger.webContents as never);

    expect(minimize).not.toHaveBeenCalled();
    expect(main.focusMainWindow).not.toHaveBeenCalled();
    expect(sftpWindowState(stranger.webContents as never)).toEqual({ isMaximized: false });
    expect(isSftpWindow(stranger.webContents as never)).toBe(false);
  });

  it('answers the state and tells the window when it is maximized or restored', () => {
    const { window } = popOut('sess-13');
    const isMaximized = vi.spyOn(window, 'isMaximized').mockReturnValue(true);

    expect(sftpWindowState(window.webContents as never)).toEqual({ isMaximized: true });
    window.emit('maximize');
    isMaximized.mockReturnValue(false);
    window.emit('unmaximize');

    expect(window.webContents.sentOn(IPC.sftp.onWindowState)).toEqual([
      [{ isMaximized: true }],
      [{ isMaximized: false }],
    ]);
    window.destroy();
    window.emit('maximize');
    expect(window.webContents.sentOn(IPC.sftp.onWindowState)).toHaveLength(2);
  });

  it('back to main hands the sessions over, focuses the server page and closes the pop-out', () => {
    const { window, service } = popOut('sess-14', owners(), 'srv/2');
    const mainId = (main.window as FakeBrowserWindow).webContents.id;

    sftpBackToMain(service, window.webContents as never);

    expect(service.adoptSessions).toHaveBeenCalledWith(window.webContents.id, mainId);
    expect(service.adoptSessions.mock.invocationCallOrder[0]).toBeLessThan(
      main.focusMainWindow.mock.invocationCallOrder[0],
    );
    expect(main.focusMainWindow).toHaveBeenCalledWith('/ssh-files/srv%2F2');
    expect(window.isDestroyed()).toBe(true);
  });
});
