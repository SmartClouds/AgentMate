import { randomUUID } from 'node:crypto';
import type { ScheduledTask, ScheduledTaskStatus } from '@runova/core';
import { ipcMain } from 'electron';
import type {
  CreateScheduledTasksInput,
  ScheduledTaskInput,
  UpdateScheduledTaskInput,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { editTelegramMessage, sendTelegramMessage } from '../notifications/telegramApi';
import { store } from '../store';

const STATUS_LABEL: Record<ScheduledTaskStatus, string> = {
  pending: '⏳ Pending',
  completed: '✅ Completed',
  cancelled: '❌ Cancelled',
  missed: '⚠️ Missed',
};

function renderTaskMessage(task: ScheduledTask, projectName: string): string {
  const runLine =
    task.runMode === 'auto'
      ? `Runs automatically at: ${new Date(task.runAt).toLocaleString()}`
      : 'Runs: manually';
  const cliLine = [task.cliId, task.model, task.effort].filter(Boolean).join(' · ');
  return [
    `📅 Scheduled task: ${projectName}`,
    `Target: ${task.targetAI}`,
    ...(cliLine ? [`CLI: ${cliLine}`] : []),
    runLine,
    `Status: ${STATUS_LABEL[task.status]}`,
    '',
    task.content,
  ].join('\n');
}

async function projectName(projectId: string): Promise<string> {
  const projects = await store.getProjects();
  return projects.find((p) => p.id === projectId)?.name ?? 'Unknown project';
}

/**
 * Announces each new task in the Telegram chat set aside for scheduled tasks and
 * records the message it posted, so later changes can edit that same message
 * instead of posting a second one. A task is created either way, so a
 * missing token or a failed send is silently skipped rather than raised.
 */
async function announceOnTelegram(tasks: ScheduledTask[], projectId: string): Promise<void> {
  const settings = await store.getSettings();
  const { telegramBotToken, telegramScheduledTasksChatId } = settings;
  if (!telegramBotToken || !telegramScheduledTasksChatId) return;

  const name = await projectName(projectId);
  for (const task of tasks) {
    const result = await sendTelegramMessage(
      telegramBotToken,
      telegramScheduledTasksChatId,
      renderTaskMessage(task, name),
    );
    if (result.ok) {
      task.telegramChatId = telegramScheduledTasksChatId;
      task.telegramMessageId = result.messageId ?? null;
    }
  }
}

/** Brings the task's Telegram message in line with its current state, if it has one. */
async function syncTelegramMessage(task: ScheduledTask): Promise<void> {
  if (!task.telegramChatId || !task.telegramMessageId) return;
  const settings = await store.getSettings();
  if (!settings.telegramBotToken) return;
  await editTelegramMessage(
    settings.telegramBotToken,
    task.telegramChatId,
    task.telegramMessageId,
    renderTaskMessage(task, await projectName(task.projectId)),
  );
}

/** Saves new tasks for a project. Shared with draft promotion so both paths announce the same way. */
export async function createScheduledTasks(
  projectId: string,
  inputs: ScheduledTaskInput[],
): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const created: ScheduledTask[] = inputs.map((task) => ({
    id: randomUUID(),
    projectId,
    rawInput: task.rawInput,
    promptType: task.promptType,
    targetAI: task.targetAI,
    content: task.content,
    runAt: task.runAt,
    status: 'pending',
    createdAt: now,
    runMode: task.runMode ?? 'manual',
    ...(task.cliId ? { cliId: task.cliId } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.effort ? { effort: task.effort } : {}),
    ranAt: null,
  }));

  await announceOnTelegram(created, projectId);

  const tasks = await store.getScheduledTasks();
  tasks.push(...created);
  await store.setScheduledTasks(tasks);
  return created;
}

/**
 * Applies a change to one task and keeps its Telegram message in step. A null or empty CLI,
 * model or effort clears it, so "use the default" can be chosen again after picking one.
 */
export async function updateScheduledTask(
  taskId: string,
  patch: UpdateScheduledTaskInput & { ranAt?: string | null },
): Promise<ScheduledTask | null> {
  const tasks = await store.getScheduledTasks();
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index === -1) return null;
  const { cliId, model, effort, ...rest } = patch;
  const updated: ScheduledTask = { ...tasks[index], ...rest };
  // Present but empty means "back to the default"; absent means "leave it alone".
  if (cliId !== undefined) updated.cliId = cliId || undefined;
  if (model !== undefined) updated.model = model || undefined;
  if (effort !== undefined) updated.effort = effort ?? undefined;
  for (const key of ['cliId', 'model', 'effort'] as const) {
    if (updated[key] === undefined) delete updated[key];
  }
  // Moving a missed or finished task to a new time puts it back in the queue.
  if (patch.runAt && patch.runAt !== tasks[index].runAt && !patch.status) {
    if (updated.status === 'missed') updated.status = 'pending';
  }
  tasks[index] = updated;
  await store.setScheduledTasks(tasks);
  await syncTelegramMessage(updated);
  return updated;
}

export function registerScheduledTaskHandlers(): void {
  ipcMain.handle(
    IPC.scheduledTasks.list,
    (): Promise<ScheduledTask[]> => store.getScheduledTasks(),
  );

  ipcMain.handle(
    IPC.scheduledTasks.listByProject,
    async (_event, projectId: string): Promise<ScheduledTask[]> => {
      const tasks = await store.getScheduledTasks();
      return tasks.filter((task) => task.projectId === projectId);
    },
  );

  ipcMain.handle(
    IPC.scheduledTasks.createMany,
    (_event, input: CreateScheduledTasksInput): Promise<ScheduledTask[]> =>
      createScheduledTasks(input.projectId, input.tasks),
  );

  ipcMain.handle(
    IPC.scheduledTasks.updateStatus,
    async (_event, taskId: string, status: ScheduledTaskStatus): Promise<void> => {
      await updateScheduledTask(taskId, { status });
    },
  );

  ipcMain.handle(
    IPC.scheduledTasks.update,
    (_event, taskId: string, patch: UpdateScheduledTaskInput): Promise<ScheduledTask | null> =>
      updateScheduledTask(taskId, patch),
  );

  ipcMain.handle(IPC.scheduledTasks.markRan, async (_event, taskId: string): Promise<void> => {
    await updateScheduledTask(taskId, { status: 'completed', ranAt: new Date().toISOString() });
  });

  ipcMain.handle(IPC.scheduledTasks.remove, async (_event, taskId: string): Promise<void> => {
    const tasks = await store.getScheduledTasks();
    await store.setScheduledTasks(tasks.filter((task) => task.id !== taskId));
  });
}
