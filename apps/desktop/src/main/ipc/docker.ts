import { ipcMain } from 'electron';
import type {
  DockerActionResult,
  DockerContainer,
  DockerImage,
  DockerImageRemoveResult,
  DockerImageTarget,
  DockerRemoveOptions,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  isDockerAvailable,
  listContainers,
  listContainersForProject,
  listImages,
  listRunningContainersForProject,
  removeContainer,
  removeImages,
  restartContainer,
  startContainer,
  stopContainer,
} from '../docker/dockerCli';

function isImageTargets(value: unknown): value is DockerImageTarget[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        Array.isArray(item.tags) &&
        item.tags.every((tag: unknown) => typeof tag === 'string'),
    )
  );
}

export function registerDockerHandlers(): void {
  ipcMain.handle(IPC.docker.availability, (): Promise<boolean> => isDockerAvailable());

  ipcMain.handle(IPC.docker.list, (): Promise<DockerContainer[]> => listContainers());

  ipcMain.handle(
    IPC.docker.listForProject,
    (_event, folderPath: string): Promise<DockerContainer[]> =>
      listContainersForProject(folderPath),
  );

  ipcMain.handle(
    IPC.docker.runningForProject,
    (_event, folderPath: string): Promise<DockerContainer[]> =>
      listRunningContainersForProject(folderPath),
  );

  ipcMain.handle(
    IPC.docker.start,
    (_event, id: string): Promise<DockerActionResult> => startContainer(id),
  );

  ipcMain.handle(
    IPC.docker.stop,
    (_event, id: string): Promise<DockerActionResult> => stopContainer(id),
  );

  ipcMain.handle(
    IPC.docker.restart,
    (_event, id: string): Promise<DockerActionResult> => restartContainer(id),
  );

  ipcMain.handle(
    IPC.docker.remove,
    (_event, id: string, options: DockerRemoveOptions): Promise<DockerActionResult> =>
      removeContainer(id, options),
  );

  ipcMain.handle(IPC.docker.listImages, (): Promise<DockerImage[]> => listImages());

  ipcMain.handle(
    IPC.docker.removeImages,
    (_event, targets: unknown): Promise<DockerImageRemoveResult> => {
      if (!isImageTargets(targets)) throw new Error('Expected a list of images to remove.');
      return removeImages(targets);
    },
  );
}
