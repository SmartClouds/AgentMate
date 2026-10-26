import { randomUUID } from 'node:crypto';
import type { ProjectDraft, ProjectDraftStatus, ScheduledTask } from '@runova/core';
import { ipcMain } from 'electron';
import type {
  CreateProjectDraftInput,
  ScheduledTaskInput,
  UpdateProjectDraftInput,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { store } from '../store';
import { createScheduledTasks } from './scheduledTasks';

export function registerProjectDraftHandlers(): void {
  ipcMain.handle(
    IPC.projectDrafts.listByProject,
    async (_event, projectId: string): Promise<ProjectDraft[]> => {
      const drafts = await store.getProjectDrafts();
      return drafts.filter((draft) => draft.projectId === projectId);
    },
  );

  ipcMain.handle(
    IPC.projectDrafts.create,
    async (_event, input: CreateProjectDraftInput): Promise<ProjectDraft> => {
      const draft: ProjectDraft = {
        id: randomUUID(),
        projectId: input.projectId,
        rawInput: input.rawInput,
        promptType: input.promptType,
        targetAI: input.targetAI,
        content: input.content,
        status: 'draft',
        createdAt: new Date().toISOString(),
        implementedAt: null,
      };
      const drafts = await store.getProjectDrafts();
      drafts.push(draft);
      await store.setProjectDrafts(drafts);
      return draft;
    },
  );

  ipcMain.handle(
    IPC.projectDrafts.updateStatus,
    async (_event, draftId: string, status: ProjectDraftStatus): Promise<void> => {
      const drafts = await store.getProjectDrafts();
      const index = drafts.findIndex((draft) => draft.id === draftId);
      if (index === -1) return;
      drafts[index] = {
        ...drafts[index],
        status,
        // Reopening clears the timestamp so it can't claim a date it was never finished on.
        implementedAt: status === 'implemented' ? new Date().toISOString() : null,
      };
      await store.setProjectDrafts(drafts);
    },
  );

  ipcMain.handle(
    IPC.projectDrafts.update,
    async (
      _event,
      draftId: string,
      patch: UpdateProjectDraftInput,
    ): Promise<ProjectDraft | null> => {
      const drafts = await store.getProjectDrafts();
      const index = drafts.findIndex((draft) => draft.id === draftId);
      if (index === -1) return null;
      drafts[index] = { ...drafts[index], ...patch };
      await store.setProjectDrafts(drafts);
      return drafts[index];
    },
  );

  // A finished draft moves over to the schedule instead of living in both lists.
  ipcMain.handle(
    IPC.projectDrafts.promoteToScheduled,
    async (_event, draftId: string, input: ScheduledTaskInput): Promise<ScheduledTask | null> => {
      const drafts = await store.getProjectDrafts();
      const draft = drafts.find((entry) => entry.id === draftId);
      if (!draft) return null;
      const [task] = await createScheduledTasks(draft.projectId, [input]);
      await store.setProjectDrafts(drafts.filter((entry) => entry.id !== draftId));
      return task;
    },
  );

  ipcMain.handle(IPC.projectDrafts.remove, async (_event, draftId: string): Promise<void> => {
    const drafts = await store.getProjectDrafts();
    await store.setProjectDrafts(drafts.filter((draft) => draft.id !== draftId));
  });
}
