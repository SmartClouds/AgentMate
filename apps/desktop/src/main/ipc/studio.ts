import { readFile, stat, writeFile } from 'node:fs/promises';
import {
  studioAiInputs,
  studioAudioInputs,
  studioGenInputs,
  studioInputs,
  studioMediaInputs,
  studioRenderInputs,
} from '@runova/studio';
import { IMPORT_EXTENSIONS } from '@runova/studio/node';
import { BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain, shell } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/ipcChannels';
import { studioService } from '../studio';

/**
 * Studio's channels (E31), its AI channels (E32), scenes (E33), rendering (E34) and voice (E36). Every argument is checked against Studio's own input schemas before
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
  handle(IPC.studio.setSceneHosts, (value) =>
    service().setSceneHosts(parse(studioInputs.setSceneHosts, value)),
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
  handle(IPC.studio.compareVersions, (value) =>
    service().compareVersions(parse(studioInputs.compare, value)),
  );
  handle(IPC.studio.treeFiles, (value) =>
    service().treeFiles(parse(studioInputs.treeFiles, value)),
  );
  handle(IPC.studio.branch, (value) => service().branchVideo(parse(studioInputs.branch, value)));
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
  handle(IPC.studioAi.recipeVersions, (value) =>
    service().recipeVersions(parse(studioAiInputs.recipeRef, value)),
  );
  handle(IPC.studioAi.recipeVersion, (value) =>
    service().recipeVersion(parse(studioAiInputs.recipeVersion, value)),
  );
  handle(IPC.studioAi.exportRecipe, async (value, event) => {
    const { recipeId } = parse(studioAiInputs.recipeRef, value);
    const { name, text } = await service().exportRecipe({ recipeId });
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Export recipe',
      defaultPath: `${name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Recipe'}.amrecipe.json`,
      filters: [{ name: 'Studio recipe', extensions: ['amrecipe.json', 'json'] }],
    };
    const picked = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return null;
    await writeFile(picked.filePath, text, 'utf8');
    return picked.filePath;
  });
  handle(IPC.studioAi.importRecipe, async (_value, event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Import recipe',
      properties: ['openFile'] as 'openFile'[],
      filters: [{ name: 'Studio recipe', extensions: ['json'] }],
    };
    const picked = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const file = picked.filePaths[0];
    if (picked.canceled || !file) return null;
    const info = await stat(file);
    if (info.size > 5 * 1024 * 1024) throw new Error('That file is too large to be a recipe.');
    return service().importRecipe({ text: await readFile(file, 'utf8') });
  });
  handle(IPC.studioScenes.animate, (value) =>
    service().startScene(parse(studioAiInputs.startScene, value)),
  );
  handle(IPC.studioScenes.code, (value) =>
    service().sceneCode(parse(studioAiInputs.sceneRef, value)),
  );
  handle(IPC.studioScenes.saveFiles, (value) =>
    service().saveSceneFiles(parse(studioAiInputs.saveSceneFiles, value)),
  );
  handle(IPC.studioScenes.useRevision, (value) =>
    service().useCodeRevision(parse(studioAiInputs.useCodeRevision, value)),
  );
  handle(IPC.studioScenes.check, (value) =>
    service().checkScene(parse(studioAiInputs.sceneRef, value)),
  );
  handle(IPC.studioScenes.thumbnail, async (value) => {
    const png = await service().thumbnail(parse(studioAiInputs.thumbnail, value));
    return png ? `data:image/png;base64,${Buffer.from(png).toString('base64')}` : null;
  });
  handle(IPC.studioScenes.styleReference, (value) =>
    service().styleReference(parse(studioAiInputs.styleReference, value)),
  );
  handle(IPC.studioScenes.checkStyle, (value) =>
    service().checkStyleReference(parse(studioAiInputs.styleReference, value)),
  );
  handle(IPC.studioMedia.pickAndImport, async (value, event) => {
    const { videoId } = parse(studioMediaInputs.videoRef, value);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const strip = (ext: readonly string[]) => ext.map((e) => e.slice(1));
    const options = {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      filters: [
        {
          name: 'Video, sound and pictures',
          extensions: strip([
            ...IMPORT_EXTENSIONS.video,
            ...IMPORT_EXTENSIONS.audio,
            ...IMPORT_EXTENSIONS.image,
          ]),
        },
        { name: 'Video', extensions: strip(IMPORT_EXTENSIONS.video) },
        { name: 'Sound', extensions: strip(IMPORT_EXTENSIONS.audio) },
        { name: 'Pictures', extensions: strip(IMPORT_EXTENSIONS.image) },
      ],
    };
    const picked = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return service().importMedia({ videoId, paths: picked.filePaths });
  });
  handle(IPC.studioMedia.importFiles, (value) =>
    service().importMedia(parse(studioMediaInputs.importFiles, value)),
  );
  handle(IPC.studioMedia.list, (value) =>
    service().media(parse(studioMediaInputs.videoRef, value)),
  );
  handle(IPC.studioAudio.engines, () => service().voiceEngines());
  handle(IPC.studioAudio.voices, (value) =>
    service().voices(parse(studioAudioInputs.voices, value)),
  );
  handle(IPC.studioAudio.setKey, (value) =>
    service().setVoiceKey(parse(studioAudioInputs.setKey, value)),
  );
  handle(IPC.studioAudio.speak, (value) => service().speak(parse(studioAudioInputs.speak, value)));
  handle(IPC.studioAudio.jobs, (value) =>
    service().narrationJobs(parse(studioAudioInputs.jobs, value)),
  );
  handle(IPC.studioAudio.cancel, (value) =>
    service().cancelNarration(parse(studioAudioInputs.jobRef, value)),
  );
  handle(IPC.studioAudio.record, (value) =>
    service().recordNarration(parse(studioAudioInputs.record, value)),
  );
  handle(IPC.studioAudio.captionScene, (value) =>
    service().captionScene(parse(studioAudioInputs.captionScene, value)),
  );
  handle(IPC.studioAudio.profiles, () => service().voiceProfiles());
  handle(IPC.studioAudio.transcribeTake, (value) =>
    service().transcribeTake(parse(studioAudioInputs.transcribeTake, value)),
  );
  handle(IPC.studioAudio.createProfile, (value) =>
    service().createVoiceProfile(parse(studioAudioInputs.createProfile, value)),
  );
  handle(IPC.studioAudio.updateProfile, (value) =>
    service().updateVoiceProfile(parse(studioAudioInputs.updateProfile, value)),
  );
  handle(IPC.studioAudio.cloneProfile, (value) =>
    service().cloneVoiceProfile(parse(studioAudioInputs.cloneProfile, value)),
  );
  handle(IPC.studioAudio.removeProfile, (value) =>
    service().removeVoiceProfile(parse(studioAudioInputs.profileRef, value)),
  );
  handle(IPC.studioGen.estimate, (value) =>
    service().genEstimate(parse(studioGenInputs.estimate, value)),
  );
  handle(IPC.studioGen.start, (value) => service().startGen(parse(studioGenInputs.start, value)));
  handle(IPC.studioGen.jobs, (value) => service().genJobs(parse(studioGenInputs.jobs, value)));
  handle(IPC.studioGen.cancel, (value) =>
    service().cancelGen(parse(studioGenInputs.jobRef, value)),
  );
  handle(IPC.studioRender.tools, () => service().renderTools());
  handle(IPC.studioRender.estimate, (value) =>
    service().renderEstimate(parse(studioRenderInputs.videoRef, value)),
  );
  handle(IPC.studioRender.start, (value) =>
    service().startRender(parse(studioRenderInputs.start, value)),
  );
  handle(IPC.studioRender.jobs, (value) =>
    service().renderJobs(parse(studioRenderInputs.jobs, value ?? {})),
  );
  handle(IPC.studioRender.cancel, (value) =>
    service().cancelRender(parse(studioRenderInputs.jobRef, value)),
  );
  handle(IPC.studioRender.retry, (value) =>
    service().retryRender(parse(studioRenderInputs.jobRef, value)),
  );
  handle(IPC.studioRender.remove, (value) =>
    service().removeRender(parse(studioRenderInputs.jobRef, value)),
  );
  // The path comes from the render's own record, never from the renderer.
  const finishedFile = async (value: unknown) => {
    const { jobId } = parse(studioRenderInputs.jobRef, value);
    const job = (await service().renderJobs({})).find((j) => j.id === jobId);
    if (!job?.output) throw new Error('That render has no finished file.');
    return job.output;
  };
  handle(IPC.studioRender.reveal, async (value) => {
    shell.showItemInFolder(await finishedFile(value));
  });
  handle(IPC.studioRender.openFile, async (value) => {
    const problem = await shell.openPath(await finishedFile(value));
    if (problem) throw new Error(problem);
  });
  handle(IPC.studio.revealVideo, async (value) => {
    const { videoId } = parse(studioInputs.videoRef, value);
    const video = (await service().list()).find((v) => v.id === videoId);
    if (!video) throw new Error('That video is not in the Studio library.');
    await shell.openPath(video.folder);
  });
}
