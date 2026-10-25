// First, before anything can read userData: it may point this run at another profile.
import './testMode';
import { join } from 'node:path';
import { BLUEPRINT_FILE_SCHEME } from '@agentmat/core';
import { app, BrowserWindow, desktopCapturer, protocol, session, shell } from 'electron';
import icon from '../../resources/icon.ico?asset';
import { BROWSER_PARTITION } from '../shared/browserGuest';
import { stopAllRdpTasks } from './agents/rdpTaskRunner';
import { flushSshTaskHistory, stopAllSshTasks } from './agents/sshTaskRunner';
import { stopEmulatorsOnQuit } from './android/runtime';
import { appCsp, keepsOwnCsp } from './appCsp';
import { registerBlueprintFileProtocol } from './blueprintFileStore';
import { configureBrowserSession, setupBrowserGuests } from './browser/guestSession';
import { registerDeployIpc } from './deploy';
import { pruneOrphanFileSites } from './deploy/files/store';
import { disposeDevSetup } from './devSetup/runtime';
import { pruneOrphanErrorLinks } from './errorTracking/store';
import { seedExampleRepositoryIfEmpty } from './exampleSkillRepo';
import { shutdownLocalServer } from './grammar/localServer';
import { startHealthScheduler, stopHealthScheduler } from './health/scheduler';
import { pruneOrphanHealthTargets } from './health/store';
import { registerActivityHandlers } from './ipc/activity';
import { registerAgentHandlers } from './ipc/agents';
import { registerAiHandlers } from './ipc/ai';
import { registerAndroidHandlers } from './ipc/android';
import { registerApiClientHandlers, shutdownApiClient } from './ipc/apiClient';
import { registerAppHandlers } from './ipc/app';
import { registerAppNotificationHandlers } from './ipc/appNotifications';
import { registerBackupHandlers } from './ipc/backup';
import { registerBlueprintHandlers } from './ipc/blueprints';
import { registerBrowserHandlers } from './ipc/browser';
import { registerCliDetectionHandlers } from './ipc/cliDetection';
import { registerDevSetupHandlers } from './ipc/devSetup';
import { registerDockerHandlers } from './ipc/docker';
import { registerEnvironmentHandlers } from './ipc/environments';
import { registerErrorTrackingHandlers } from './ipc/errorTracking';
import { registerExplorerHandlers } from './ipc/explorer';
import { registerFileSystemHandlers } from './ipc/fileSystem';
import { registerGitHandlers } from './ipc/git';
import { registerGrammarHandlers } from './ipc/grammar';
import { registerHealthHandlers } from './ipc/health';
import { registerHelpHandlers } from './ipc/help';
import { registerIpGeoHandlers } from './ipc/ipGeo';
import { registerMcpHandlers } from './ipc/mcp';
import { registerNotificationHandlers } from './ipc/notifications';
import { registerPackageManagerHandlers } from './ipc/packageManagers';
import { registerPetHandlers } from './ipc/pet';
import { registerPipelineHandlers } from './ipc/pipelines';
import { registerPowerHandlers } from './ipc/power';
import { registerProjectDraftHandlers } from './ipc/projectDrafts';
import { registerProjectHandlers } from './ipc/projects';
import { registerPromptBuildWidgetHandlers } from './ipc/promptBuildWidget';
import { registerPromptHistoryHandlers } from './ipc/promptHistory';
import { registerProxyHandlers } from './ipc/proxy';
import { registerPullRequestHandlers } from './ipc/pullRequests';
import { closeAllRdpSessions, registerRdpHandlers } from './ipc/rdp';
import { registerRdpAgentHandlers } from './ipc/rdpAgent';
import { registerRelayHandlers } from './ipc/relay';
import { registerRemoteHandlers } from './ipc/remote';
import { registerResourceActivityHandlers } from './ipc/resourceActivity';
import { registerRunProposalHandlers } from './ipc/runProposals';
import { registerScheduledTaskHandlers } from './ipc/scheduledTasks';
import { registerSecurityHandlers } from './ipc/security';
import { registerSettingsHandlers } from './ipc/settings';
import { sftpSenderAllowed } from './ipc/sftp';
import { registerShellHandlers } from './ipc/shell';
import { registerSkillHandlers } from './ipc/skills';
import { registerSpeechHandlers, shutdownSpeech } from './ipc/speech';
import { killAllSshSessions, registerSshHandlers } from './ipc/ssh';
import { registerSshAgentHandlers } from './ipc/sshAgent';
import { registerStudioHandlers } from './ipc/studio';
import { registerSystemStatsHandlers } from './ipc/systemStats';
import { registerTemplateHandlers } from './ipc/templates';
import { registerTerminalHandlers, startTerminalBackend, terminalsHoldQuit } from './ipc/terminal';
import { registerTerminalClipboardHandlers } from './ipc/terminalClipboard';
import { registerTestHandlers } from './ipc/tests';
import { registerToolHandlers } from './ipc/tools';
import { registerTranslateHandlers } from './ipc/translate';
import { registerUsageHandlers } from './ipc/usage';
import { registerWindowHandlers } from './ipc/window';
import { registerWorkspaceSearchHandlers } from './ipc/workspaceSearch';
import { registerWorktreeHandlers } from './ipc/worktrees';
import { flushLastRoute, prepareStartupRoute, takeStartupRoute, trackLastRoute } from './lastRoute';
import { focusMainWindow, getMainWindow, setMainWindow, setMainWindowFactory } from './mainWindow';
import {
  loadMainWindowState,
  MAIN_WINDOW_MIN_SIZE,
  mainWindowBounds,
  showMainWindow,
  trackMainWindowState,
} from './mainWindowState';
import {
  applyProxySettingsFromStore,
  installProxyFetch,
  registerProxyAuthHandler,
} from './network/proxy';
import {
  startNetworkQualityAlertWatcher,
  stopNetworkQualityAlertWatcher,
} from './network/qualityAlerts';
import { startHookServer, stopHookServer } from './notifications/hookServer';
import { registerNotificationActivation } from './notifications/osNotification';
import { petManager } from './pet/petWindow';
import { startPipelineWatcher, stopPipelineWatcher } from './pipelines/watcher';
import { promptBuildWidgetManager } from './promptBuild/widgetWindows';
import { allowQuit, guardQuit, registerQuitGuardHandlers } from './quitGuard';
import { pruneOrphanRelays } from './relay/store';
import { startRelayService } from './relay/wiring';
import { remoteManager } from './remote/manager';
import {
  startResourceActivityTracker,
  stopResourceActivityTracker,
} from './resourceActivity/runtime';
import { startScheduledTaskRunner, stopScheduledTaskRunner } from './scheduledTasks/scheduler';
import { cancelAllSecurityScans, sweepOrphanScanContainers } from './security/scanRunner';
import { closeAllSftpSessions, registerSftpIpc } from './sftp';
import { isSftpWindow } from './sftp/window';
import { refreshShellPath } from './shellPath';
import { configureSpellChecker, registerSpellcheckHandlers } from './spellcheck';
import {
  getSplash,
  handOffWhenReady,
  setSplashStatus,
  showSplash,
  themeBackground,
} from './splashWindow';
import { lockVault } from './ssh/vault';
import {
  migrateInlineProjectIcons,
  pruneOrphanBlueprints,
  pruneOrphanEnvironments,
  store,
} from './store';
import { pruneStudioProjects, resumeStudioRenders, shutdownStudio } from './studio';
import {
  handleStudioMedia,
  handleStudioScenes,
  STUDIO_MEDIA_PRIVILEGES,
  STUDIO_SCHEME_PRIVILEGES,
} from './studio/protocol';
import { showRosettaNotice } from './system/rosettaNotice';
import { isE2E, keepWindowsHidden } from './testMode';
import { startToolUpdateWatcher, stopToolUpdateWatcher } from './toolUpdates/watcher';
import { startHourlyUpdateChecks } from './updater';
import { startResetAlertWatcher, stopResetAlertWatcher } from './usage/resetAlerts';
import { startThresholdAlertWatcher, stopThresholdAlertWatcher } from './usage/thresholdAlerts';
import { widgetManager } from './usage/widgetWindows';
import { getVaultService, registerVaultIpc, startVault } from './vault';
import { titleBarFrameOptions } from './windowChrome';
import {
  applyWindowTheme,
  currentWindowTheme,
  glassWindowOptions,
  mainWindowGlass,
  mainWindowQuery,
} from './windowGlass';

// Chromium normally deprioritizes timers, rendering, and IPC delivery for a
// minimized/occluded window (and Windows' own efficiency-mode throttling
// piles on top of that). That combination is what makes the terminal drawer's
// pty sessions appear to freeze or reset a short while after the window is
// minimized, and if the app was launched from a shell running inside one of
// those terminals, drags the whole app down with it. These switches keep the
// main window's renderer running at full priority regardless of window state.
// Has to run before the app is ready, which is why it sits up here with the
// command-line switches rather than beside the handler that serves it.
// `stream` is the one that matters: without it an attached video downloads in
// full before it plays and can't be seeked at all.
protocol.registerSchemesAsPrivileged([
  {
    scheme: BLUEPRINT_FILE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  STUDIO_SCHEME_PRIVILEGES,
  STUDIO_MEDIA_PRIVILEGES,
]);

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Distinct name in dev so `electron-vite dev` gets its own userData dir and
// single-instance lock instead of colliding with an installed release build
// (same name -> same lock -> dev process loses the race and quits, while the
// already-running release instance gets focused, looking like "dev opened
// release").
app.setName(app.isPackaged ? 'AgentMate' : 'AgentMate Dev');
// Windows groups notifications/taskbar entries by this id rather than the exe
// name, so without it toasts show up as "Electron" with the Electron icon.
// Must match electron-builder.yml's `appId` so the packaged install (which
// registers that id via its shortcut) and dev runs agree on identity.
if (process.platform === 'win32') app.setAppUserModelId('com.agentmate.app');

// Both are safe before the app is ready and before the settings file has been
// read: the fetch shim passes everything through to Node until a proxy is
// actually configured, and the login handler ignores challenges until then.
installProxyFetch();
registerProxyAuthHandler();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A relaunch (electron-vite's dev restart, or `app.relaunch()` from settings) starts the new
 * process while the old one is still shutting down. On Windows the old process still has the
 * SingletonLock file open, so creating it fails with a sharing violation:
 *
 *   process_singleton_win.cc: Lock file can not be created! Error code: 32
 *
 * Chromium reports that the same way as "another instance owns the lock", so quitting on the
 * first failure makes the app vanish on restart instead of coming back. Retry for a moment to
 * give the old process time to let go. A genuine second launch still loses and quits, just a
 * beat later, after re-notifying (and re-focusing) the instance that is already running.
 */
function acquireSingleInstanceLock(): boolean {
  const attempts = app.isPackaged ? 4 : 10;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (app.requestSingleInstanceLock()) return true;
    if (attempt < attempts - 1) sleepSync(200);
  }
  return false;
}

const isSingleInstance = acquireSingleInstanceLock();
if (!isSingleInstance) {
  app.quit();
}

/** The theme's page color, read at startup so the window never flashes a different one. */
let windowBackground = '#050807';
/** Set for the first window of a launch: it stays hidden until the splash hands over. */
let revealAfterSplash = false;

function createMainWindow(): BrowserWindow {
  const behindSplash = revealAfterSplash;
  revealAfterSplash = false;
  const savedState = loadMainWindowState();
  const glass = mainWindowGlass();
  const win = new BrowserWindow({
    ...mainWindowBounds(savedState),
    minWidth: MAIN_WINDOW_MIN_SIZE.width,
    minHeight: MAIN_WINDOW_MIN_SIZE.height,
    show: false,
    ...titleBarFrameOptions(),
    autoHideMenuBar: true,
    ...glassWindowOptions(glass, windowBackground),
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // Keep terminal output flowing and the pty session healthy while the
      // window is minimized; see the command-line switches above.
      backgroundThrottling: false,
      // The workspace browser tab. Every guest is locked down in setupBrowserGuests below.
      webviewTag: true,
    },
  });

  trackMainWindowState(win, savedState.isMaximized);
  trackLastRoute(win);
  const reveal = (): void => showMainWindow(win, savedState);
  if (behindSplash) {
    handOffWhenReady(win, reveal);
  } else {
    win.once('ready-to-show', () => {
      if (!keepWindowsHidden) reveal();
    });
  }
  setMainWindow(win);
  registerWindowHandlers(win);
  setupBrowserGuests(win);
  remoteManager.init(win);

  // On Windows and Linux closing this window closes the app, so ask first while CLIs, SSH or
  // Remote Desktop sessions are open. macOS keeps running without it and asks on Cmd+Q instead.
  win.on('close', (event) => {
    if (process.platform !== 'darwin') guardQuit(event);
  });
  // Logging off or shutting down must not get stuck behind the question.
  win.on('session-end', () => allowQuit());

  // Closing the main window tears down the floating usage widgets too, so the
  // app can fully quit on Windows/Linux instead of lingering with only
  // taskbar-less widget windows (they're persisted and restored next launch).
  win.on('closed', () => {
    if (process.platform !== 'darwin') {
      widgetManager.closeAll();
      promptBuildWidgetManager.closeAll();
      petManager.close();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
      // biome-ignore lint/suspicious/noConsole: forwards renderer console output into the main process log
      console.log(`[renderer] ${sourceId}:${line} ${message}`);
    });
  }

  // Any attempt to open a new window/tab (target="_blank", window.open) is
  // redirected to the user's default browser instead of a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Opens on the page the app was left on (or the one picked in Settings), so the dashboard does
  // not flash first. A deep link that arrives during startup still wins: it is parked and taken
  // once the page is up.
  const route = takeStartupRoute();
  const hash = route === '/' ? undefined : route;
  // The page reads these before its first paint (see mainWindowQuery).
  const query = mainWindowQuery(glass, currentWindowTheme());
  if (process.env.ELECTRON_RENDERER_URL) {
    const search = new URLSearchParams(query).toString();
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${search}${hash ? `#${hash}` : ''}`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash, query });
  }

  return win;
}

function registerAllIpcHandlers(): void {
  registerAppHandlers();
  registerQuitGuardHandlers();
  registerCliDetectionHandlers();
  registerTerminalHandlers();
  registerSshHandlers();
  registerRdpHandlers();
  registerEnvironmentHandlers();
  registerApiClientHandlers();
  registerSshAgentHandlers();
  registerRdpAgentHandlers();
  registerAgentHandlers();
  registerTerminalClipboardHandlers();
  registerBrowserHandlers();
  registerPowerHandlers();
  registerProjectHandlers();
  registerRunProposalHandlers();
  registerProxyHandlers();
  registerSkillHandlers();
  registerMcpHandlers();
  registerSecurityHandlers();
  // A crash or a force-quit can leave a scan's containers running; clear them before any
  // new scan tries to reuse the same names. Docker is machine-wide, so an e2e run leaves the
  // containers of whatever else is on this machine alone.
  if (!isE2E) sweepOrphanScanContainers();
  registerToolHandlers();
  registerDevSetupHandlers();
  registerAndroidHandlers();
  registerDockerHandlers();
  registerResourceActivityHandlers();
  registerFileSystemHandlers();
  registerExplorerHandlers();
  registerWorkspaceSearchHandlers();
  registerSettingsHandlers();
  registerTemplateHandlers();
  registerActivityHandlers();
  registerShellHandlers();
  registerPromptHistoryHandlers();
  registerTranslateHandlers();
  registerSystemStatsHandlers();
  registerIpGeoHandlers();
  registerProjectDraftHandlers();
  registerScheduledTaskHandlers();
  registerNotificationHandlers();
  registerAiHandlers();
  registerHelpHandlers();
  registerSpeechHandlers();
  registerGitHandlers();
  registerWorktreeHandlers();
  registerPackageManagerHandlers();
  registerRemoteHandlers();
  registerUsageHandlers();
  registerBackupHandlers();
  registerBlueprintHandlers();
  registerPromptBuildWidgetHandlers();
  registerPetHandlers();
  registerPipelineHandlers();
  registerDeployIpc();
  registerPullRequestHandlers();
  registerTestHandlers();
  registerVaultIpc();
  registerAppNotificationHandlers();
  registerSpellcheckHandlers();
  registerGrammarHandlers();
  registerRelayHandlers();
  // Health targets carry sealed keys, so only the main window's own page may reach them.
  registerHealthHandlers({
    guard: (event) => {
      const win = getMainWindow();
      return (
        !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      );
    },
  });
  // Error tracking (E24) holds sealed Sentry tokens, so the same main window guard applies.
  registerErrorTrackingHandlers({
    guard: (event) => {
      const win = getMainWindow();
      return (
        !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      );
    },
  });
  // The SFTP file manager (E25) logs in with saved servers' secrets: the main window and the
  // file manager's own pop-out windows only, each from its top frame.
  registerSftpIpc({
    guard: (event) => sftpSenderAllowed(event, getMainWindow(), isSftpWindow),
  });
  // Studio (E31) moves and trashes folders and writes video files, so it answers the main window
  // only, like the stores holding secrets above.
  registerStudioHandlers({
    guard: (event) => {
      const win = getMainWindow();
      return (
        !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      );
    },
  });
}

app.whenReady().then(async () => {
  // The splash goes up first so a click on the app shows something right away. It needs the
  // theme, and the settings file is small, so that one read comes before it.
  const { theme } = await store.getSettings();
  windowBackground = themeBackground(theme);
  applyWindowTheme(theme);
  let splashUp: Promise<void> = Promise.resolve();
  if (!keepWindowsHidden) {
    splashUp = showSplash(theme);
    revealAfterSplash = true;
  }
  setSplashStatus('Loading settings...');

  // Not awaited: a Mac app opened from Finder has none of the shell's PATH, so this starts reading
  // it right away, and CLI detection waits for the same read instead of starting another.
  void refreshShellPath();

  // Ahead of every other startup step, so the first update check, widget
  // refresh, or usage poll already goes the configured way. The splash has to be
  // fully drawn too, since the synchronous work below would otherwise stall it.
  // The launch page is worked out here too, so the window can start loading as soon as it exists.
  await Promise.all([applyProxySettingsFromStore(), splashUp, prepareStartupRoute()]);

  const isDev = !!process.env.ELECTRON_RENDERER_URL;
  // The policy and why each part is there are in appCsp.ts, with a test that spells it out.
  const csp = appCsp({
    isDev,
    blueprintScheme: BLUEPRINT_FILE_SCHEME,
    studioSceneScheme: STUDIO_SCHEME_PRIVILEGES.scheme,
    studioMediaScheme: STUDIO_MEDIA_PRIVILEGES.scheme,
  });

  configureBrowserSession(session.fromPartition(BROWSER_PARTITION));

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // A Studio scene page keeps its own, stricter policy (no network at all).
    if (keepsOwnCsp(details.url, STUDIO_SCHEME_PRIVILEGES.scheme)) {
      callback({});
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  // Prompt Builder's voice input calls getUserMedia for the microphone. Electron
  // grants permission requests by default (the same default that lets every
  // "Copy" button use navigator.clipboard), so no permission handler is needed
  // here. Adding a restrictive one would break clipboard writes and the Remote
  // feature. On macOS the OS still gates the mic behind its own TCC prompt,
  // which needs NSMicrophoneUsageDescription in the packaged Info.plist (see
  // electron-builder.yml).

  // When the Remote page (host side) calls getDisplayMedia, capture the primary
  // screen directly instead of popping the OS source picker. The operator has
  // already opted in by starting a host session.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback(sources.length ? { video: sources[0] } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  setSplashStatus('Starting services...');
  configureSpellChecker();
  registerBlueprintFileProtocol();
  handleStudioScenes(protocol);
  handleStudioMedia(protocol);
  registerAllIpcHandlers();
  void store.getSettings().then(startVault);
  startTerminalBackend();
  void seedExampleRepositoryIfEmpty();
  void migrateInlineProjectIcons();
  void pruneOrphanBlueprints();
  void pruneOrphanEnvironments();
  void pruneOrphanHealthTargets();
  void pruneOrphanRelays();
  void pruneOrphanErrorLinks();
  void pruneOrphanFileSites();
  void pruneStudioProjects();
  // Relay legs report through the hook server, so it starts first; neither blocks the window.
  void startHookServer().then(() => startRelayService().catch(() => undefined));
  setMainWindowFactory(createMainWindow);
  // Nothing answers a confirmation dialog in a test, so closing must not ask.
  if (isE2E) allowQuit();
  setSplashStatus('Loading your workspace...');
  const mainWin = createMainWindow();
  // A render picked up again opens hidden scene windows, which wait until the main window is
  // there, so the first window of the app is always the main one and startup has the machine.
  mainWin.webContents.once('did-finish-load', () => {
    void resumeStudioRenders(join(app.getPath('userData'), 'data', 'studio'));
  });
  // The Intel build on an Apple Silicon Mac can't run git, so say so once the window is up.
  if (!isE2E) mainWin.once('show', () => void showRosettaNotice(mainWin));
  registerNotificationActivation();
  void widgetManager.restoreAll();
  void promptBuildWidgetManager.restoreAll();
  void petManager.syncFromSettings();
  startResetAlertWatcher();
  startThresholdAlertWatcher();
  startNetworkQualityAlertWatcher();
  // Reads Docker and adb in the background, which a test run has no business doing.
  if (!isE2E) startResourceActivityTracker();
  startPipelineWatcher();
  startToolUpdateWatcher();
  startHealthScheduler();
  startScheduledTaskRunner();
  startHourlyUpdateChecks();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Another launch while this one runs. During startup the splash is what's on screen, so that's
// what comes forward; the main window stays hidden until it has loaded.
app.on('second-instance', () => {
  const splash = getSplash();
  if (splash) {
    splash.focus();
    return;
  }
  focusMainWindow();
});

// Terminal sessions are left alone here: on macOS the app keeps running with no window, and
// reopening one reattaches to the same shells. Quitting decides their fate in before-quit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  // Asks before anything is torn down, and only once per quit the user agrees to.
  if (!guardQuit(event)) return;
  // The page the window is on, for the next launch. Written first, before anything can fail.
  flushLastRoute();
  // Terminals settle first. If that takes a moment (ending shells in the background host),
  // this quit is put off and retried, and the teardown below runs on the second pass.
  const terminalsSettling = terminalsHoldQuit();
  if (terminalsSettling) {
    event.preventDefault();
    void terminalsSettling.finally(() => app.quit());
    return;
  }
  cancelAllSecurityScans();
  // The last second of AI task history may still be waiting on its debounce.
  void flushSshTaskHistory();
  // An install the person started from Dev Setup would otherwise keep running with no window.
  disposeDevSetup();
  // Not awaited: emulators are left running by default, and a half-booted one must never be
  // able to hold the shutdown open.
  void store
    .getSettings()
    .then((settings) => stopEmulatorsOnQuit(settings.androidStopEmulatorsOnQuit === true));
  petManager.close();
  stopHookServer();
  stopResetAlertWatcher();
  stopThresholdAlertWatcher();
  stopNetworkQualityAlertWatcher();
  stopResourceActivityTracker();
  stopPipelineWatcher();
  stopToolUpdateWatcher();
  stopHealthScheduler();
  stopScheduledTaskRunner();
  shutdownLocalServer();
  remoteManager.shutdown();
  stopAllSshTasks();
  stopAllRdpTasks();
  killAllSshSessions();
  closeAllSftpSessions();
  closeAllRdpSessions();
  lockVault();
  void getVaultService().shutdown();
  shutdownApiClient();
  shutdownSpeech();
  // Every edit is already committed to its video's history; this writes document.json and
  // releases the folders' locks. A lock left behind by a crash is taken over on the next start.
  void shutdownStudio();
});
