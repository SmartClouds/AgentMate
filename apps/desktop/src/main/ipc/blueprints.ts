import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  BlueprintAttachment,
  BlueprintPreset,
  BlueprintRevision,
  BlueprintSection,
  BlueprintStepId,
  Project,
  ProjectBlueprint,
} from '@agentmat/core';
import {
  AGENT_INSTRUCTION_FILES,
  applyManagedBlock,
  createBlankBlueprint,
  flattenAttachmentRefs,
  normalizeBlueprintPreset,
  normalizeDocsFolder,
  removeAttachmentRefs,
  renderBlueprintBlock,
} from '@agentmat/core';
import { dialog, ipcMain } from 'electron';
import { z } from 'zod';
import type {
  BlueprintAgentFileResult,
  BlueprintAgentFileTarget,
  BlueprintAttachmentInput,
  BlueprintAttachmentResult,
  BlueprintSectionPatch,
  SaveBlueprintPresetInput,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  ATTACHMENT_EXTENSIONS,
  attachmentPath,
  writeAttachmentFromDataUrl,
  writeAttachmentFromPath,
} from '../blueprintFileStore';
import { blueprintRevisionDb } from '../blueprintRevisionDb';
import { assertPathWithinRoots } from '../pathGuard';
import { store } from '../store';
import { allowedRoots } from './fileSystem';

/** The Relay split as the renderer may set it: a switch and a budget a model can hold. */
const relaySettingSchema = z
  .object({
    enabled: z.boolean(),
    budgetTokens: z.number().int().min(10_000).max(2_000_000),
  })
  .strict();

async function findProject(projectId: string): Promise<Project> {
  const project = (await store.getProjects()).find((entry) => entry.id === projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  return project;
}

/**
 * Find-or-create, so the renderer never has to deal with a project that has no
 * blueprint yet. Creating one is cheap and happens the first time the tab opens.
 */
async function loadBlueprint(projectId: string): Promise<ProjectBlueprint> {
  const blueprints = await store.getBlueprints();
  const existing = blueprints.find((entry) => entry.projectId === projectId);
  if (existing) return existing;

  const created = createBlankBlueprint(randomUUID(), projectId);
  await store.setBlueprints([...blueprints, created]);
  return created;
}

/** Applies a change and stamps `updatedAt`, the way `mutateProject` does for projects. */
async function mutateBlueprint(
  projectId: string,
  mutate: (current: ProjectBlueprint) => ProjectBlueprint,
): Promise<ProjectBlueprint> {
  const blueprints = await store.getBlueprints();
  const index = blueprints.findIndex((entry) => entry.projectId === projectId);
  const current = index === -1 ? createBlankBlueprint(randomUUID(), projectId) : blueprints[index];
  const updated: ProjectBlueprint = {
    ...mutate(current),
    updatedAt: new Date().toISOString(),
  };
  if (index === -1) blueprints.push(updated);
  else blueprints[index] = updated;
  await store.setBlueprints(blueprints);
  return updated;
}

function mapSection(
  blueprint: ProjectBlueprint,
  stepId: BlueprintStepId,
  mutate: (section: BlueprintSection) => BlueprintSection,
): ProjectBlueprint {
  return {
    ...blueprint,
    sections: blueprint.sections.map((section) =>
      section.stepId === stepId ? mutate(section) : section,
    ),
  };
}

function sectionFor(blueprint: ProjectBlueprint, stepId: BlueprintStepId): BlueprintSection {
  const section = blueprint.sections.find((entry) => entry.stepId === stepId);
  // The read normalizer guarantees one section per step, so this only fires for
  // a step id that isn't one.
  if (!section) throw new Error(`Unknown blueprint step: ${stepId}`);
  return section;
}

function recordSectionRevision(blueprint: ProjectBlueprint, stepId: BlueprintStepId): void {
  const section = sectionFor(blueprint, stepId);
  blueprintRevisionDb.add({
    blueprintId: blueprint.id,
    projectId: blueprint.projectId,
    target: 'section',
    stepId,
    text: section.text,
    attachmentNames: section.attachments.map((attachment) => attachment.displayName),
  });
}

/**
 * The instruction file this project's agent actually reads. The first candidate
 * is what AgentMate's own bootstrap writes; a repo that came from somewhere else
 * often has one of the others already, and writing the one nobody reads would
 * look like it worked and do nothing.
 */
async function resolveAgentFile(project: Project): Promise<BlueprintAgentFileTarget> {
  const candidates = AGENT_INSTRUCTION_FILES[project.agentType] ?? ['AGENTS.md'];
  const roots = await allowedRoots();
  for (const candidate of candidates) {
    const absolute = await assertPathWithinRoots(
      join(project.folderPath, ...candidate.split('/')),
      roots,
    );
    try {
      await access(absolute);
      return { path: absolute, relativePath: candidate, exists: true };
    } catch {
      // Not there: keep looking, and fall back to the canonical one below.
    }
  }
  const canonical = candidates[0];
  return {
    path: await assertPathWithinRoots(join(project.folderPath, ...canonical.split('/')), roots),
    relativePath: canonical,
    exists: false,
  };
}

async function syncAgentFile(projectId: string): Promise<BlueprintAgentFileResult> {
  const project = await findProject(projectId);
  const blueprint = await loadBlueprint(projectId);
  const target = await resolveAgentFile(project);

  const body = renderBlueprintBlock(
    blueprint.sections
      .filter((section) => section.includeInAgentFile)
      // The English rendering is the more useful one in a file an agent reads
      // alongside English instructions, but it only exists after a generate run.
      .map((section) => ({
        stepId: section.stepId,
        // Same reason the prompt flattens them: this file lives in the user's
        // repo, where an agentmate-file:// image would be a dead link.
        text: flattenAttachmentRefs(section.textEn ?? section.text),
      })),
  );

  let existing = '';
  try {
    existing = await readFile(target.path, 'utf-8');
  } catch {
    // No file yet. Nothing ticked means there is also nothing to create.
    if (!body.trim()) {
      return { path: target.path, relativePath: target.relativePath, written: false };
    }
  }

  const next = applyManagedBlock(existing, body);
  if (next === existing) {
    return { path: target.path, relativePath: target.relativePath, written: false };
  }
  await mkdir(dirname(target.path), { recursive: true });
  await writeFile(target.path, next, 'utf-8');
  return { path: target.path, relativePath: target.relativePath, written: true };
}

/**
 * Lookups are scoped to what this project's blueprint actually holds, so an id
 * from somewhere else can't be used to pull a file out of the store.
 */
async function findAttachment(
  projectId: string,
  attachmentId: string,
): Promise<BlueprintAttachment | null> {
  const blueprint = await loadBlueprint(projectId);
  return (
    blueprint.sections
      .flatMap((section) => section.attachments)
      .find((entry) => entry.id === attachmentId) ?? null
  );
}

export function registerBlueprintHandlers(): void {
  ipcMain.handle(
    IPC.blueprints.get,
    (_event, projectId: string): Promise<ProjectBlueprint> => loadBlueprint(projectId),
  );

  ipcMain.handle(
    IPC.blueprints.updateSection,
    async (
      _event,
      projectId: string,
      stepId: BlueprintStepId,
      patch: BlueprintSectionPatch,
    ): Promise<ProjectBlueprint> => {
      const now = new Date().toISOString();
      const updated = await mutateBlueprint(projectId, (blueprint) =>
        mapSection(blueprint, stepId, (section) => {
          const next: BlueprintSection = { ...section, updatedAt: now };
          if (patch.text !== undefined) {
            next.text = patch.text;
            // An edit invalidates the cached English copy, so the next generate
            // translates what is there now instead of reusing what the old text said.
            next.textEn = null;
            next.textEnHash = null;
          }
          if (patch.textEn !== undefined) next.textEn = patch.textEn;
          if (patch.textEnHash !== undefined) next.textEnHash = patch.textEnHash;
          if (patch.includeInAgentFile !== undefined) {
            next.includeInAgentFile = patch.includeInAgentFile;
          }
          return next;
        }),
      );

      // Only an actual edit is worth a revision. Caching a translation isn't one.
      if (patch.text !== undefined) recordSectionRevision(updated, stepId);
      return updated;
    },
  );

  ipcMain.handle(
    IPC.blueprints.setFinalPrompt,
    async (_event, projectId: string, text: string): Promise<ProjectBlueprint> => {
      const updated = await mutateBlueprint(projectId, (blueprint) => ({
        ...blueprint,
        finalPrompt: text,
        finalPromptUpdatedAt: new Date().toISOString(),
      }));
      blueprintRevisionDb.add({
        blueprintId: updated.id,
        projectId: updated.projectId,
        target: 'final-prompt',
        stepId: null,
        text,
      });
      return updated;
    },
  );

  ipcMain.handle(
    IPC.blueprints.setDocsFolder,
    (_event, projectId: string, folder: string): Promise<ProjectBlueprint> =>
      mutateBlueprint(projectId, (blueprint) => ({
        ...blueprint,
        docsFolder: normalizeDocsFolder(folder),
      })),
  );

  ipcMain.handle(
    IPC.blueprints.setConfirmBeforeWriting,
    (_event, projectId: string, value: boolean): Promise<ProjectBlueprint> =>
      mutateBlueprint(projectId, (blueprint) => ({
        ...blueprint,
        confirmBeforeWriting: value === true,
      })),
  );

  ipcMain.handle(
    IPC.blueprints.setRelay,
    (_event, projectId: string, value: unknown): Promise<ProjectBlueprint> => {
      const relay = relaySettingSchema.parse(value);
      return mutateBlueprint(projectId, (blueprint) => ({ ...blueprint, relay }));
    },
  );

  ipcMain.handle(
    IPC.blueprints.pickAttachments,
    async (
      _event,
      projectId: string,
      stepId: BlueprintStepId,
    ): Promise<BlueprintAttachmentResult | null> => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Attachments', extensions: ATTACHMENT_EXTENSIONS }],
      });
      if (result.canceled || result.filePaths.length === 0) return null;

      const added: BlueprintAttachment[] = [];
      for (const filePath of result.filePaths) {
        // The bytes are read and written here, so a picked file never crosses IPC.
        added.push(await writeAttachmentFromPath(filePath));
      }
      // `added` goes back so the editor can drop each file in at the caret; the
      // record alone would not say which of the files are the new ones.
      const blueprint = await mutateBlueprint(projectId, (current) =>
        mapSection(current, stepId, (section) => ({
          ...section,
          attachments: [...section.attachments, ...added],
        })),
      );
      return { blueprint, added };
    },
  );

  ipcMain.handle(
    IPC.blueprints.addAttachment,
    async (
      _event,
      projectId: string,
      stepId: BlueprintStepId,
      input: BlueprintAttachmentInput,
    ): Promise<BlueprintAttachmentResult> => {
      const attachment = await writeAttachmentFromDataUrl(input.displayName, input.dataUrl);
      const blueprint = await mutateBlueprint(projectId, (current) =>
        mapSection(current, stepId, (section) => ({
          ...section,
          attachments: [...section.attachments, attachment],
        })),
      );
      return { blueprint, added: [attachment] };
    },
  );

  ipcMain.handle(
    IPC.blueprints.renameAttachment,
    (
      _event,
      projectId: string,
      stepId: BlueprintStepId,
      attachmentId: string,
      displayName: string,
    ): Promise<ProjectBlueprint> =>
      mutateBlueprint(projectId, (blueprint) =>
        mapSection(blueprint, stepId, (section) => ({
          ...section,
          attachments: section.attachments.map((attachment) =>
            attachment.id === attachmentId
              ? { ...attachment, displayName: displayName.trim() || attachment.fileName }
              : attachment,
          ),
        })),
      ),
  );

  ipcMain.handle(
    IPC.blueprints.removeAttachment,
    async (
      _event,
      projectId: string,
      stepId: BlueprintStepId,
      attachmentId: string,
    ): Promise<ProjectBlueprint> => {
      const existing = await loadBlueprint(projectId);
      const gone = sectionFor(existing, stepId).attachments.find(
        (attachment) => attachment.id === attachmentId,
      );
      if (!gone) return existing;

      // The file itself goes when the record is stored: setBlueprints collects
      // anything no blueprint points at any more. Its references in the step
      // have to go with it, or the preview keeps a broken image the user can
      // only clear by editing the markdown by hand.
      const updated = await mutateBlueprint(projectId, (blueprint) =>
        mapSection(blueprint, stepId, (section) => {
          const text = removeAttachmentRefs(section.text, gone.fileName);
          return {
            ...section,
            text,
            ...(text === section.text ? {} : { textEn: null, textEnHash: null }),
            attachments: section.attachments.filter((attachment) => attachment.id !== attachmentId),
            updatedAt: new Date().toISOString(),
          };
        }),
      );
      if (sectionFor(updated, stepId).text !== sectionFor(existing, stepId).text) {
        recordSectionRevision(updated, stepId);
      }
      return updated;
    },
  );

  ipcMain.handle(
    IPC.blueprints.attachmentPath,
    async (_event, projectId: string, attachmentId: string): Promise<string | null> => {
      const attachment = await findAttachment(projectId, attachmentId);
      return attachment ? attachmentPath(attachment.fileName) : null;
    },
  );

  ipcMain.handle(
    IPC.blueprints.listRevisions,
    (_event, projectId: string, stepId: BlueprintStepId | null): BlueprintRevision[] =>
      blueprintRevisionDb.list(projectId, stepId),
  );

  ipcMain.handle(
    IPC.blueprints.agentFileTarget,
    async (_event, projectId: string): Promise<BlueprintAgentFileTarget> =>
      resolveAgentFile(await findProject(projectId)),
  );

  ipcMain.handle(
    IPC.blueprints.syncAgentFile,
    (_event, projectId: string): Promise<BlueprintAgentFileResult> => syncAgentFile(projectId),
  );

  ipcMain.handle(
    IPC.blueprints.listPresets,
    (): Promise<BlueprintPreset[]> => store.getBlueprintPresets(),
  );

  ipcMain.handle(
    IPC.blueprints.savePreset,
    async (_event, input: SaveBlueprintPresetInput): Promise<BlueprintPreset[]> => {
      const presets = await store.getBlueprintPresets();
      const preset = normalizeBlueprintPreset({
        id: input.id ?? randomUUID(),
        stepId: input.stepId,
        label: input.label,
        text: input.text,
        createdAt: presets.find((entry) => entry.id === input.id)?.createdAt,
      });
      if (!preset) throw new Error('A preset needs a name and some text.');

      const index = presets.findIndex((entry) => entry.id === preset.id);
      if (index === -1) presets.unshift(preset);
      else presets[index] = preset;
      await store.setBlueprintPresets(presets);
      return presets;
    },
  );

  ipcMain.handle(
    IPC.blueprints.deletePreset,
    async (_event, presetId: string): Promise<BlueprintPreset[]> => {
      const presets = (await store.getBlueprintPresets()).filter((entry) => entry.id !== presetId);
      await store.setBlueprintPresets(presets);
      return presets;
    },
  );
}
