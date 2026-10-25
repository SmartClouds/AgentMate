import { studioAiInputs, studioInputs } from '@agentmat/studio';
import { BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain, shell } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/ipcChannels';
import { studioService } from '../studio';

/**
 * Studio's channels (E31), and its AI channels (E32). Every argument is checked against Studio's own input schemas before
 * the service sees it; the service then checks folders and edits again on its own terms.
 */

/**
 * Studio's schemas come from the package's own zod, which can be a different copy than the app's,
 * so this takes any schema by shape rather than the app's `z.ZodType`.
 */
type InputSchema<T> = {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
};

function parse<T>(schema: InputSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join('.');
  throw new Error(
    `That Studio request is not valid${field ? ` (${field})` : ''}: ${issue?.message ?? ''}`,
  );
}

const pickFolderInput = z.object({ defaultPath: z.string().max(4096).optional() }).optional();

/** Old copies left behind by a move in this session, the only folders Studio may put in the trash. */
const movedAway = new Set<string>();

export function registerStudioHandlers(
  options: { guard?: (event: IpcMainInvokeEvent) => boolean } = {},
): void {
  const handle = (channel: string, fn: (value: unknown, event: IpcMainInvokeEvent) => unknown) => {
    ipcMain.handle(channel, (event, value) => {
      if (options.guard && !options.guard(event)) {
        throw new Error('Studio only answers the main window.');
      }
      return fn(value, event);
    });
  };
  const service = () => studioService();

  handle(IPC.studio.settings, () => service().settings());
  handle(IPC.studio.updateSettings, (value) =>
    service().updateSettings(parse(studioInputs.updateSettings, value)),
  );
  handle(IPC.studio.projectStorage, (value) =>
    service().projectStorage(parse(studioInputs.projectRef, value)),
  );
  handle(IPC.studio.setProjectRoot, (value) =>
    service().setProjectRoot(parse(studioInputs.setProjectRoot, value)),
  );
  handle(IPC.studio.checkRoot, (value) =>
    service().checkRoot(parse(studioInputs.checkRoot, value)),
  );
  handle(IPC.studio.pickFolder, async (value, event) => {
    const input = parse(pickFolderInput, value);
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = {
      defaultPath: input?.defaultPath,
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(IPC.studio.list, (value) => service().list(parse(studioInputs.list, value)));
  handle(IPC.studio.create, (value) => service().create(parse(studioInputs.create, value)));
  handle(IPC.studio.open, (value) => service().open(parse(studioInputs.videoRef, value)));
  handle(IPC.studio.takeOver, (value) => service().takeOver(parse(studioInputs.videoRef, value)));
  handle(IPC.studio.close, (value) => service().close(parse(studioInputs.videoRef, value)));
  handle(IPC.studio.apply, (value) => service().apply(parse(studioInputs.apply, value)));
  handle(IPC.studio.undo, (value) => service().undo(parse(studioInputs.videoRef, value)));
  handle(IPC.studio.redo, (value) => service().redo(parse(studioInputs.videoRef, value)));
  handle(IPC.studio.history, (value) => service().history(parse(studioInputs.history, value)));
  handle(IPC.studio.version, (value) => service().version(parse(studioInputs.version, value)));
  handle(IPC.studio.restore, (value) => service().restore(parse(studioInputs.version, value)));
  handle(IPC.studio.addExisting, (value) =>
    service().addExisting(parse(studioInputs.folder, value)),
  );
  handle(IPC.studio.locate, (value) => service().locate(parse(studioInputs.locate, value)));
  handle(IPC.studio.removeFromLibrary, (value) =>
    service().removeFromLibrary(parse(studioInputs.videoRef, value)),
  );
  handle(IPC.studio.move, async (value) => {
    const result = await service().move(parse(studioInputs.move, value));
    movedAway.add(result.oldFolder);
    return result;
  });
  handle(IPC.studio.trashOldFolder, async (value) => {
    const { folder } = parse(studioInputs.folder, value);
    if (!movedAway.has(folder)) {
      throw new Error('Studio can only remove the old copy of a video it just moved.');
    }
    movedAway.delete(folder);
    await shell.trashItem(folder);
  });
  handle(IPC.studioAi.startScenario, (value) =>
    service().startScenario(parse(studioAiInputs.startScenario, value)),
  );
  handle(IPC.studioAi.startEdit, (value) =>
    service().startEdit(parse(studioAiInputs.startEdit, value)),
  );
  handle(IPC.studioAi.retry, (value) =>
    service().retryGeneration(parse(studioAiInputs.generationRef, value)),
  );
  handle(IPC.studioAi.cancel, (value) =>
    service().cancelGeneration(parse(studioAiInputs.generationRef, value)),
  );
  handle(IPC.studioAi.generations, (value) =>
    service().generations(parse(studioAiInputs.generations, value)),
  );
  handle(IPC.studioAi.generationDetail, (value) =>
    service().generationDetail(parse(studioAiInputs.generationRef, value)),
  );
  handle(IPC.studioAi.applyProposal, (value) =>
    service().applyProposal(parse(studioAiInputs.generationRef, value)),
  );
  handle(IPC.studioAi.discardProposal, (value) =>
    service().discardProposal(parse(studioAiInputs.generationRef, value)),
  );
  handle(IPC.studioAi.recipes, () => service().recipes());
  handle(IPC.studioAi.saveRecipe, (value) =>
    service().saveRecipe(parse(studioAiInputs.saveRecipe, value)),
  );
  handle(IPC.studioAi.deleteRecipe, (value) =>
    service().deleteRecipe(parse(studioAiInputs.recipeRef, value)),
  );
  handle(IPC.studio.revealVideo, async (value) => {
    const { videoId } = parse(studioInputs.videoRef, value);
    const video = (await service().list()).find((v) => v.id === videoId);
    if (!video) throw new Error('That video is not in the Studio library.');
    await shell.openPath(video.folder);
  });
}
