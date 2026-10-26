import type { RunDockerStopMode } from '@runova/core';
import type { DockerContainer } from '@shared/apiTypes';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { queryClient } from '@/queryClient';
import { promptStopContainers } from '@/stores/stopContainersPromptStore';

/** A run that was just stopped: the folder it ran in and the name to call it by. */
export interface StoppedRun {
  cwd?: string;
  title: string;
}

/** Containers a stop is already underway for. Docker lists them as running until it finishes. */
const stopping = new Set<string>();

function containerCount(count: number): string {
  return `${count} container${count === 1 ? '' : 's'}`;
}

async function readMode(): Promise<RunDockerStopMode> {
  try {
    const settings = await window.runova.settings.get();
    return settings?.stopDockerWithRun ?? 'ask';
  } catch {
    // Asking is the safe default: it never stops anything on its own.
    return 'ask';
  }
}

async function stopContainers(ids: string[]): Promise<void> {
  const fresh = ids.filter((id) => !stopping.has(id));
  if (fresh.length === 0) return;
  for (const id of fresh) stopping.add(id);

  const toastId = toast.loading(`Stopping ${containerCount(fresh.length)}…`);
  try {
    const results = await Promise.all(
      fresh.map((id) =>
        window.runova.docker.stop(id).catch(() => ({ ok: false as const, error: undefined })),
      ),
    );
    const failed = results.filter((result) => !result?.ok).length;
    if (failed === 0) {
      toast.success(`Stopped ${containerCount(fresh.length)}.`, { id: toastId });
    } else {
      const message =
        fresh.length === 1
          ? 'The container failed to stop.'
          : `${failed} of ${fresh.length} containers failed to stop.`;
      toast.error(message, { id: toastId });
    }
  } finally {
    for (const id of fresh) stopping.delete(id);
    void queryClient.invalidateQueries({ queryKey: queryKeys.dockerList });
  }
}

async function remember(mode: RunDockerStopMode): Promise<void> {
  try {
    await window.runova.settings.update({ stopDockerWithRun: mode });
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
  } catch {
    // Not being able to save the preference only means being asked again next time.
  }
}

/**
 * Called after a project's run has been stopped. If that project still has Docker containers
 * running, either asks whether to stop them too or acts on the saved answer, so a run that
 * brought up a database or a queue does not leave it eating memory behind the user's back.
 *
 * It never gets in the way: the run is already gone, nothing is shown unless there are containers,
 * and any failure in looking them up is silent.
 */
export async function offerStopContainers(runs: StoppedRun[]): Promise<void> {
  const folders = [...new Set(runs.flatMap((run) => (run.cwd ? [run.cwd] : [])))];
  if (folders.length === 0) return;

  const mode = await readMode();
  if (mode === 'keep') return;

  const lookups = await Promise.allSettled(
    folders.map((folder) => window.runova.docker.runningForProject(folder)),
  );
  const projects: string[] = [];
  const containers = new Map<string, DockerContainer>();
  lookups.forEach((lookup, index) => {
    if (lookup.status !== 'fulfilled') return;
    const found = (lookup.value ?? []).filter((one) => !stopping.has(one.id));
    if (found.length === 0) return;
    for (const one of found) containers.set(one.id, one);
    for (const run of runs) {
      if (run.cwd === folders[index] && !projects.includes(run.title)) projects.push(run.title);
    }
  });
  if (containers.size === 0) return;

  if (mode === 'stop') {
    await stopContainers([...containers.keys()]);
    return;
  }

  const answer = await promptStopContainers({ projects, containers: [...containers.values()] });
  // null: the offer was folded into a dialog that is already open, which acts for it.
  if (!answer) return;
  if (answer.remember) await remember(answer.stopIds.length > 0 ? 'stop' : 'keep');
  await stopContainers(answer.stopIds);
}
