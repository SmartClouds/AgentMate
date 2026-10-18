import { app, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../../shared/ipcChannels';
import { registerDeployFilesHandlers } from '../../ipc/deployFiles';
import { broadcastToWindows } from '../../ipc/send';
import { showOsNotification } from '../../notifications/osNotification';
import { createFilesService, type FilesService, type FilesServiceDeps } from './service';
import { registerFileSitesSealedStore } from './store';

/**
 * Wires FTP and SFTP sites (E23) into Electron: the store's sealed secrets move with a Servers
 * passkey change, every window hears about the sites, their changes and their runs, a review of
 * Deploy on save shows an OS notification that opens the site, and the IPC handlers answer the
 * main window. At startup the journals stopped runs left are folded and Deploy on save starts
 * where it is on; at quit every run, watcher and timer stops.
 */

const C = IPC.deployFiles;

export function registerDeployFilesIpc(deps: {
  guard: (event: IpcMainInvokeEvent) => boolean;
  /** Tests only: stand-ins for the transports and the folder watcher. */
  overrides?: Partial<FilesServiceDeps>;
}): FilesService {
  registerFileSitesSealedStore();
  const service = createFilesService({
    events: {
      changes: (snapshot) => broadcastToWindows(C.onChanges, snapshot),
      progress: (event) => broadcastToWindows(C.onProgress, event),
      runFinished: (result) => broadcastToWindows(C.onRunFinished, result),
      needsReview: (event) => broadcastToWindows(C.onNeedsReview, event),
      sitesChanged: (sites) => broadcastToWindows(C.onSitesChanged, { sites }),
    },
    notify: (site, review) => {
      showOsNotification({
        title: `${site.label} needs a look`,
        body: review.message,
        route: `/deploy?files=${encodeURIComponent(site.id)}`,
      });
    },
    ...deps.overrides,
  });
  registerDeployFilesHandlers({ service, guard: deps.guard });
  void service.start().catch(() => undefined);
  app.on('will-quit', () => service.close());
  return service;
}
