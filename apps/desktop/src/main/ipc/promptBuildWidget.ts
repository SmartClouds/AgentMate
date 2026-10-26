import type { DesktopPromptBuildWidgetInstance } from '@runova/core';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { promptBuildWidgetManager } from '../promptBuild/widgetWindows';

export function registerPromptBuildWidgetHandlers(): void {
  ipcMain.handle(
    IPC.promptBuildWidget.listWidgets,
    (): Promise<DesktopPromptBuildWidgetInstance[]> => promptBuildWidgetManager.list(),
  );
  ipcMain.handle(
    IPC.promptBuildWidget.getWidget,
    (_e, id: string): Promise<DesktopPromptBuildWidgetInstance | null> =>
      promptBuildWidgetManager.get(id),
  );
  ipcMain.handle(
    IPC.promptBuildWidget.openWidget,
    (_e, projectId: string, projectName: string): Promise<DesktopPromptBuildWidgetInstance> =>
      promptBuildWidgetManager.open(projectId, projectName),
  );
  ipcMain.handle(
    IPC.promptBuildWidget.closeWidget,
    (_e, id: string): Promise<void> => promptBuildWidgetManager.close(id),
  );
}
