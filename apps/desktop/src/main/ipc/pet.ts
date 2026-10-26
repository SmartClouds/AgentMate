import type { CustomDesktopPet } from '@runova/core';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import type { PetSnoozeState, PetWorkArea } from '../../shared/pet';
import { focusMainWindow } from '../mainWindow';
import { customPetDataUrls, importCustomPet, removeCustomPet } from '../pet/customPets';
import { petManager } from '../pet/petWindow';

export function registerPetHandlers(): void {
  ipcMain.on(IPC.pet.setClickThrough, (_event, ignore: boolean) => {
    petManager.setClickThrough(Boolean(ignore));
  });

  ipcMain.on(IPC.pet.setDragGuard, (_event, active: boolean) => {
    petManager.setDragGuard(Boolean(active));
  });

  ipcMain.on(IPC.pet.showMainWindow, (_event, route?: unknown) => {
    // Only in-app routes, never an arbitrary URL the renderer could hand over.
    const target = typeof route === 'string' && route.startsWith('/') ? route : undefined;
    focusMainWindow(target);
  });

  ipcMain.handle(IPC.pet.getWorkArea, (): PetWorkArea => petManager.workArea());
  ipcMain.handle(IPC.pet.importCustom, (): Promise<CustomDesktopPet | null> => importCustomPet());
  ipcMain.handle(IPC.pet.removeCustom, async (_event, id: string): Promise<void> => {
    await removeCustomPet(String(id));
  });
  ipcMain.handle(
    IPC.pet.customDataUrls,
    (): Promise<Record<string, string>> => customPetDataUrls(),
  );

  ipcMain.handle(
    IPC.pet.snooze,
    (_event, minutes: number): PetSnoozeState => petManager.snooze(Number(minutes)),
  );
  ipcMain.handle(IPC.pet.cancelSnooze, (): PetSnoozeState => petManager.cancelSnooze());
  ipcMain.handle(IPC.pet.getSnooze, (): PetSnoozeState => petManager.snoozeState());
}
