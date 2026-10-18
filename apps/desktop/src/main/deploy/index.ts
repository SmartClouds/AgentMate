import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, dialog, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { registryOfImage } from '../../shared/deploy/registries';
import { IPC } from '../../shared/ipcChannels';
import { indexProjectFiles } from '../explorer/fileIndex';
import { registerDeployHandlers } from '../ipc/deploy';
import { registerDeployAppStoreHandlers } from '../ipc/deployAppStore';
import { registerDeployAssistantHandlers } from '../ipc/deployAssistant';
import { registerDeployDirectTlsHandlers } from '../ipc/deployDirectTls';
import { registerDeployDockerHandlers } from '../ipc/deployDocker';
import { registerDeployFirewallHandlers } from '../ipc/deployFirewall';
import { registerDeployHardeningHandlers } from '../ipc/deployHardening';
import { registerDeploySecurityHandlers } from '../ipc/deploySecurity';
import { registerDeploySitesHandlers } from '../ipc/deploySites';
import { registerDeployStacksHandlers } from '../ipc/deployStacks';
import { registerDeploySystemHandlers, subscriptionOwners } from '../ipc/deploySystem';
import { resolveProjectEnvironment } from '../ipc/environments';
import { broadcastToWindows, sendToWindow } from '../ipc/send';
import { getMainWindow } from '../mainWindow';
import { showOsNotification } from '../notifications/osNotification';
import { getSshPool } from '../ssh/sharedPool';
import {
  decryptSecret,
  encryptSecret,
  onVaultUnlocked,
  registerSealedSecretStore,
} from '../ssh/vault';
import { store } from '../store';
import { DownloadAbortedError, ResumableDownload } from '../updater/resumableDownload';
import { DeployAppStore } from './appStore/service';
import { approvalSigner } from './assistant/approvals';
import { DeployAssistant } from './assistant/service';
import { DeployBackups } from './backups';
import {
  githubReleaseSource,
  localArtifactSource,
  parseReleaseManifest,
  type ReleaseSource,
  repoReleaseDirectory,
} from './bootstrap/releaseSource';
import { registerCloudflareIpc } from './cloudflare';
import { DeployDirectTls } from './directTls/service';
import { DeployDocker } from './docker';
import { registerDeployFilesIpc } from './files';
import { DeployFirewall } from './firewall';
import { DeployHardening } from './hardening';
import { DockerLinks } from './live/dockerLinks';
import { DockerSubscriptions } from './live/dockerSubscriptions';
import { DeploySubscriptions } from './live/subscriptions';
import { JournalSubscriptions } from './logs/journal';
import { createDeployRegistries, registerDeployRegistryIpc } from './registry';
import type { DeployRegistries } from './registry/service';
import { DeploySecurity } from './security';
import { DeployService } from './service';
import { DeploySites } from './sites/deploySites';
import { SiteLogSubscriptions } from './sites/siteLogs';
import { buildContextTarball } from './stacks/buildContext';
import { DeployStacks } from './stacks/service';
import { DeployState, jsonFilePort } from './state';
import { DeploySystem } from './system';
import { appNotificationInbox, DeployAlertWatcher } from './watcher';
import { registerDeployWordPressIpc } from './wordpress';

/**
 * Wires the Deploy service into Electron. Packaged builds install the core release published
 * with their own version, checked against the manifest built into the app. Development builds
 * use `pnpm server-core:publish` output, and can add the DevHost with AGENTMATE_DEPLOY_DEV_CORE
 * (a loopback port); packaged builds ignore both. Every enrolled server keeps a lasting
 * connection while the app runs, for the Overview's live data and the alert watcher.
 */

const MANIFEST = 'server-core-manifest.json';
const DOWNLOAD_ATTEMPTS = 5;

interface CoreSource {
  releases: ReleaseSource;
  availableVersion: () => Promise<string | null>;
  unavailableReason?: string;
}

function unavailable(reason: string): CoreSource {
  return {
    releases: {
      release: async () => {
        throw new Error(reason);
      },
    },
    availableVersion: async () => null,
    unavailableReason: reason,
  };
}

async function downloadRelease(url: string, destination: string): Promise<void> {
  const download = new ResumableDownload();
  try {
    await download.run({
      url,
      destPath: destination,
      expectedSize: null,
      userAgent: `AgentMate/${app.getVersion()}`,
      onProgress: () => undefined,
      onReconnect: (attempt) => {
        if (attempt >= DOWNLOAD_ATTEMPTS) download.abort();
      },
    });
  } catch (error) {
    if (error instanceof DownloadAbortedError) {
      throw new Error('The server core download kept failing. Check the connection and try again.');
    }
    throw error;
  }
}

function packagedSource(): CoreSource {
  const path = join(process.resourcesPath, MANIFEST);
  if (!existsSync(path))
    return unavailable('This build of AgentMate has no server core to install.');
  const manifest = parseReleaseManifest(JSON.parse(readFileSync(path, 'utf-8')));
  return {
    releases: githubReleaseSource(
      manifest,
      join(app.getPath('userData'), 'server-core'),
      downloadRelease,
    ),
    availableVersion: async () => manifest.version,
  };
}

const NO_DEV_BUILD =
  'No server core build found. Run "pnpm server-core:publish linux-x64" (or linux-arm64) first.';

function developmentSource(): CoreSource {
  const directory =
    process.env.AGENTMATE_SERVER_CORE_ARTIFACTS ?? repoReleaseDirectory(app.getAppPath());
  if (!directory) return unavailable(NO_DEV_BUILD);
  return {
    releases: localArtifactSource(directory),
    unavailableReason: NO_DEV_BUILD,
    availableVersion: async () => {
      try {
        const manifest = readFileSync(join(directory, MANIFEST), 'utf-8');
        return parseReleaseManifest(JSON.parse(manifest)).version;
      } catch {
        return null;
      }
    },
  };
}

function devCorePort(): number | null {
  if (app.isPackaged) return null;
  const port = Number(process.env.AGENTMATE_DEPLOY_DEV_CORE);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export function registerDeployIpc(): void {
  const pool = getSshPool();
  const source = app.isPackaged ? packagedSource() : developmentSource();
  const state = new DeployState(jsonFilePort(join(app.getPath('userData'), 'data', 'deploy.json')));
  // Device keys are sealed with the Servers vault, so they move with a passkey change.
  registerSealedSecretStore(state.sealedKeys);
  let watcher: DeployAlertWatcher | null = null;
  const service = new DeployService({
    servers: () => store.getSshServers(),
    pool,
    state,
    seal: encryptSecret,
    unseal: decryptSecret,
    releases: source.releases,
    availableVersion: source.availableVersion,
    unavailableReason: source.unavailableReason,
    devCorePort: devCorePort(),
    progress: (event) => sendToWindow(getMainWindow(), IPC.deploy.onSetupProgress, event),
    connectionChanged: (connection) =>
      sendToWindow(getMainWindow(), IPC.deploy.onConnection, connection),
    serversChanged: () => void watcher?.sync(),
  });
  const guard = (event: IpcMainInvokeEvent): boolean => {
    const win = getMainWindow();
    return (
      !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
    );
  };
  registerDeployHandlers({ ipc: ipcMain, service, guard });

  const subscriptions = new DeploySubscriptions({ links: service.links });
  const ownerOf = subscriptionOwners((ownerId) => subscriptions.dropOwner(ownerId));
  registerDeploySystemHandlers({
    ipc: ipcMain,
    system: new DeploySystem({ links: service.links, roles: (id) => service.roles(id) }),
    subscriptions,
    guard,
    owner: (event) => ownerOf(event.sender),
  });

  // The firewall's safe apply confirms over a new SSH connection of its own (pool.openSeparate).
  registerDeployFirewallHandlers({
    ipc: ipcMain,
    firewall: new DeployFirewall({
      links: service.links,
      service,
      roles: (id) => service.roles(id),
      progress: (event) => sendToWindow(getMainWindow(), IPC.deployFirewall.onProgress, event),
    }),
    guard,
  });

  // Direct TLS (E16): read and changed over SSH only, so the pin never comes from the port it guards.
  registerDeployDirectTlsHandlers({
    ipc: ipcMain,
    directTls: new DeployDirectTls({ service, state, roles: (id) => service.roles(id) }),
    guard,
  });

  // Private registries (E08): this computer's sign-ins go with each deploy that pulls from them.
  const registries = createDeployRegistries();
  const stacks = new DeployStacks({
    links: service.links,
    roles: (id) => service.roles(id),
    http: (serverId, work) => service.withCoreHttp(serverId, work),
    source: {
      project: async (projectId) => {
        const project = (await store.getProjects()).find((item) => item.id === projectId);
        if (!project) throw new Error('That project no longer exists.');
        return project;
      },
      index: indexProjectFiles,
      environment: resolveProjectEnvironment,
    },
    pack: buildContextTarball,
    progress: (event) => sendToWindow(getMainWindow(), IPC.deployStacks.onUploadProgress, event),
    registryAuths: (serverId, stackId, hosts) => registries.authsFor(serverId, stackId, hosts),
  });
  registerDeployStacksHandlers({ ipc: ipcMain, stacks, guard });
  registerDeployRegistryIpc({
    registries,
    core: { links: service.links, roles: (id) => service.roles(id) },
    stacks,
    guard,
  });
  // The App Store (E12) installs and updates through the same stacks.
  registerDeployAppStoreHandlers({ ipc: ipcMain, store: new DeployAppStore({ stacks }), guard });

  // The Websites section (E10, E11): its site logs end with the window that opened them.
  const siteLogs = new SiteLogSubscriptions({ links: service.links });
  const siteLogOwnerOf = subscriptionOwners((ownerId) => siteLogs.dropOwner(ownerId));
  registerDeploySitesHandlers({
    ipc: ipcMain,
    sites: new DeploySites({ links: service.links, roles: (id) => service.roles(id) }),
    logs: siteLogs,
    guard,
    owner: (event) => siteLogOwnerOf(event.sender),
  });

  watcher = new DeployAlertWatcher({
    links: service.links,
    state,
    servers: async () =>
      (await service.listServers())
        .filter((server) => server.enrolled && server.core)
        .map((server) => ({ id: server.id, name: server.nickname })),
    inbox: appNotificationInbox({
      list: () => store.getAppNotifications(),
      save: (items) => store.setAppNotifications(items),
      changed: () => broadcastToWindows(IPC.appNotifications.onChanged),
    }),
    toast: (toast) => {
      showOsNotification(toast);
    },
    focused: () => getMainWindow()?.isFocused() ?? false,
  });
  void watcher.sync();
  // A locked vault holds every connection that needs a secret; opening it lets them carry on.
  onVaultUnlocked(() => service.links.wake('locked'));
  app.on('will-quit', () => {
    watcher?.stop();
    service.links.closeAll();
    pool.closeAll();
  });
  registerDeploySecurityIpc(service, guard);
  registerDeployHardeningIpc(service, guard);
  registerDeployDockerIpc(service, guard, registries);
  registerCloudflareIpc({
    call: (serverId, work) => service.links.call(serverId, work),
    roles: (serverId) => service.roles(serverId),
    onLinkConnection: (serverId, work) => service.onLinkConnection(serverId, work),
    serverName: async (serverId) =>
      (await service.listServers()).find((server) => server.id === serverId)?.nickname ?? serverId,
  });
  registerDeployAssistantIpc(service, state, guard);
  registerDeployWordPressIpc({ guard });
  // FTP and SFTP sites (E23): Deploy on save starts here and stops at quit.
  registerDeployFilesIpc({ guard });
}

/** The Deploy AI and the logs center's journal (E09). Approvals are signed with the device key. */
function registerDeployAssistantIpc(
  service: DeployService,
  state: DeployState,
  guard: (event: IpcMainInvokeEvent) => boolean,
): void {
  const roles = (id: string) => service.roles(id);
  const journals = new JournalSubscriptions({ links: service.links });
  const ownerOf = subscriptionOwners((ownerId) => journals.dropOwner(ownerId));
  registerDeployAssistantHandlers({
    ipc: ipcMain,
    assistant: new DeployAssistant({
      links: service.links,
      roles,
      approve: approvalSigner({ state, unseal: decryptSecret }),
      serverName: async (serverId) =>
        (await service.listServers()).find((server) => server.id === serverId)?.nickname ??
        serverId,
      docker: new DeployDocker({ links: service.links, roles }),
      send: (channel, payload) => sendToWindow(getMainWindow(), channel, payload),
    }),
    journals,
    guard,
    owner: (event) => ownerOf(event.sender),
  });
}

/** The Security area: users, devices, sessions, enrollment codes and the audit trail. */
function registerDeploySecurityIpc(
  service: DeployService,
  guard: (event: IpcMainInvokeEvent) => boolean,
): void {
  const security = new DeploySecurity({
    withHub: (serverId, work) => service.withHub(serverId, work),
    forgetTokens: (serverId) => service.forgetTokens(serverId),
    serverName: async (serverId) =>
      (await service.listServers()).find((server) => server.id === serverId)?.nickname ?? serverId,
    pickExportPath: async (format, suggestedName) => {
      const options = {
        title: 'Export the audit trail',
        defaultPath: suggestedName,
        filters: [
          format === 'csv'
            ? { name: 'CSV', extensions: ['csv'] }
            : { name: 'JSON', extensions: ['json'] },
        ],
      };
      const win = getMainWindow();
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      return result.canceled ? null : (result.filePath ?? null);
    },
    writeFile: (path, content) => writeFile(path, content, 'utf-8'),
  });
  registerDeploySecurityHandlers({ ipc: ipcMain, security, service, guard });
}

/**
 * The Security center (E15): the checklist and its SSH fixes, which go over new SSH connections
 * of their own (pool.openSeparate), and backups, saved where the user picks.
 */
function registerDeployHardeningIpc(
  service: DeployService,
  guard: (event: IpcMainInvokeEvent) => boolean,
): void {
  const dialogOwner = () => getMainWindow();
  const backups = new DeployBackups({
    withHub: (serverId, work) => service.withHub(serverId, work),
    withCoreHttp: (serverId, work) => service.withCoreHttp(serverId, work),
    serverName: async (serverId) =>
      (await service.listServers()).find((server) => server.id === serverId)?.nickname ?? serverId,
    pickSavePath: async (suggestedName) => {
      const options = {
        title: 'Save the server backup',
        defaultPath: suggestedName,
        filters: [{ name: 'AgentMate server backup', extensions: ['ambackup'] }],
      };
      const win = dialogOwner();
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      return result.canceled ? null : (result.filePath ?? null);
    },
    pickOpenPath: async () => {
      const options = {
        title: 'Restore a server backup',
        properties: ['openFile' as const],
        filters: [{ name: 'AgentMate server backup', extensions: ['ambackup'] }],
      };
      const win = dialogOwner();
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });
  registerDeployHardeningHandlers({
    ipc: ipcMain,
    hardening: new DeployHardening({
      links: service.links,
      service: {
        withFreshHub: (serverId, work, step) => service.withFreshHub(serverId, work, step),
        availableCoreVersion: () => service.availableCoreVersion(),
        loginMethod: (serverId) => service.loginMethod(serverId),
      },
      roles: (id) => service.roles(id),
      progress: (event) => sendToWindow(getMainWindow(), IPC.deployHardening.onSshProgress, event),
    }),
    backups,
    service,
    restoreProgress: (_event, serverId, progress) =>
      sendToWindow(getMainWindow(), IPC.deployHardening.onRestoreProgress, { serverId, progress }),
    guard,
  });
}

/** Docker on each server (E06): containers, their live stats, logs and consoles, and resources. */
function registerDeployDockerIpc(
  service: DeployService,
  guard: (event: IpcMainInvokeEvent) => boolean,
  registries: DeployRegistries,
): void {
  const links = new DockerLinks(service.links);
  const subscriptions = new DockerSubscriptions({ links });
  const ownerOf = subscriptionOwners((ownerId) => subscriptions.dropOwner(ownerId));
  registerDeployDockerHandlers({
    ipc: ipcMain,
    docker: new DeployDocker({
      links: service.links,
      roles: (id) => service.roles(id),
      // An image pull on the Containers screen signs in with this computer's sign-in too (E08).
      registryAuth: async (reference) =>
        (await registries.authsForRegistries([registryOfImage(reference)]))[0] ?? null,
    }),
    subscriptions,
    guard,
    owner: (event) => ownerOf(event.sender),
  });
  app.on('will-quit', () => links.closeAll());
}
