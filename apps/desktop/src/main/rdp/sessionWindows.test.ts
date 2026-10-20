import { describe, expect, it, vi } from 'vitest';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import { getRdpWindow, openRdpWindow, setRdpWindowBackgroundThrottling } from './sessionWindows';

function openFakeWindow(sessionId: string) {
  const window = openRdpWindow({
    sessionId,
    title: 'Server - Remote Desktop',
    fullScreen: false,
    maximized: false,
    onClosed: () => undefined,
  }) as unknown as FakeBrowserWindow;
  const executeJavaScript = vi.fn().mockResolvedValue(undefined);
  Object.assign(window.webContents, { executeJavaScript });
  return { window, executeJavaScript };
}

describe('Remote Desktop session windows', () => {
  it('finds the window of an open session, and forgets it once closed', () => {
    const onClosed = vi.fn();
    const window = openRdpWindow({
      sessionId: 'rdp-1',
      title: 'Server - Remote Desktop',
      fullScreen: false,
      maximized: false,
      onClosed,
    });
    expect(getRdpWindow('rdp-1')).toBe(window);
    expect(getRdpWindow('rdp-2')).toBeNull();

    window.close();
    expect(onClosed).toHaveBeenCalled();
    expect(getRdpWindow('rdp-1')).toBeNull();
  });

  it('turns background throttling off and on for a session window', () => {
    const window = openRdpWindow({
      sessionId: 'rdp-3',
      title: 'Server - Remote Desktop',
      fullScreen: false,
      maximized: false,
      onClosed: () => undefined,
    }) as unknown as FakeBrowserWindow;
    const setBackgroundThrottling = vi.fn();
    Object.assign(window.webContents, { setBackgroundThrottling });

    setRdpWindowBackgroundThrottling('rdp-3', false);
    setRdpWindowBackgroundThrottling('rdp-3', true);
    expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);

    // A session without a window is left alone.
    expect(() => setRdpWindowBackgroundThrottling('missing', false)).not.toThrow();
    window.close();
  });

  describe('how the window opens', () => {
    function showFakeWindow(sessionId: string, fullScreen: boolean, maximized: boolean) {
      const window = openRdpWindow({
        sessionId,
        title: 'Server - Remote Desktop',
        fullScreen,
        maximized,
        onClosed: () => undefined,
      }) as unknown as FakeBrowserWindow;
      const maximize = vi.spyOn(window, 'maximize');
      const setFullScreen = vi.spyOn(window, 'setFullScreen');
      window.emit('ready-to-show');
      return { window, maximize, setFullScreen };
    }

    it('maximizes, leaving the taskbar visible, when asked to', () => {
      const { window, maximize, setFullScreen } = showFakeWindow('rdp-7', false, true);
      expect(maximize).toHaveBeenCalledOnce();
      expect(setFullScreen).not.toHaveBeenCalled();
      expect(window.isVisible()).toBe(true);
      window.close();
    });

    it('opens a normal window when maximizing is off', () => {
      const { window, maximize, setFullScreen } = showFakeWindow('rdp-8', false, false);
      expect(maximize).not.toHaveBeenCalled();
      expect(setFullScreen).not.toHaveBeenCalled();
      expect(window.isVisible()).toBe(true);
      window.close();
    });

    it('goes full screen when asked to, and then does not also maximize', () => {
      const { window, maximize, setFullScreen } = showFakeWindow('rdp-9', true, true);
      expect(setFullScreen).toHaveBeenCalledWith(true);
      expect(maximize).not.toHaveBeenCalled();
      expect(window.isVisible()).toBe(true);
      window.close();
    });
  });

  // Chromium only lets the page capture Win+V and friends while it is in HTML full screen.
  it('puts the page into HTML full screen when the window goes full screen, and out again', () => {
    const { window, executeJavaScript } = openFakeWindow('rdp-4');

    window.emit('enter-full-screen');
    expect(executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('requestFullscreen()'),
      true,
    );

    window.emit('leave-full-screen');
    expect(executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('exitFullscreen()'),
      true,
    );
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
    window.close();
  });

  it('keeps the window usable when the page refuses HTML full screen', async () => {
    const { window, executeJavaScript } = openFakeWindow('rdp-5');
    executeJavaScript.mockRejectedValue(new Error('Script failed to execute'));

    expect(() => window.emit('enter-full-screen')).not.toThrow();
    await Promise.resolve();
    window.close();
  });

  it('leaves a destroyed window alone', () => {
    const { window, executeJavaScript } = openFakeWindow('rdp-6');
    window.destroy();

    window.emit('leave-full-screen');

    expect(executeJavaScript).not.toHaveBeenCalled();
  });
});
