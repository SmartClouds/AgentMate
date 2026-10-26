import type { Project, WpItemRef } from '@runova/core';
import { wordPressErrorMessage } from '@shared/wordpressErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { replaceProject } from '@/components/projects/wordpress/useUnlinkWordPressProject';
import { queryKeys } from '@/lib/queryKeys';
import { useWordPressOperationStore } from '@/stores/wordpressOperationStore';
import { addItemPlan, removeItemPlan } from './itemProjects';

/**
 * Adds a site's theme or plugin to a project, takes it out, or moves it from one project to
 * another, through the WordPress operation store so the progress shows in an OperationTimeline.
 * A move adds first and removes second, so a failed add changes nothing.
 */

export interface ItemProjectOutcome {
  ok: boolean;
  /** What went wrong, ready to show. Set when `ok` is false. */
  error?: string;
  /** Items linked without a pull because their folders already held files (`linkProject`). */
  notPulled?: WpItemRef[];
  /** A move whose add worked but whose remove failed: the item is in both projects now. */
  partial?: boolean;
}

export interface ItemProjectActions {
  /** The operation running right now, for the timeline. Null when idle. */
  operationId: string | null;
  busy: boolean;
  add: (project: Project, item: WpItemRef) => Promise<ItemProjectOutcome>;
  /** Unlinks the project when the item is its last one. Does not ask; the caller confirms. */
  remove: (project: Project, item: WpItemRef) => Promise<ItemProjectOutcome>;
  move: (from: Project, to: Project, item: WpItemRef) => Promise<ItemProjectOutcome>;
  /** Forgets the finished operation, so the dialog can go back to its form. */
  reset: () => void;
}

function planError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useItemProjectActions(siteId: string): ItemProjectActions {
  const queryClient = useQueryClient();
  const [operationId, setOperationIdState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A ref as well, so reset() called from an older render still finds the run.
  const operationRef = useRef<string | null>(null);

  function setOperationId(id: string | null): void {
    operationRef.current = id;
    setOperationIdState(id);
  }

  function updated(project: Project): void {
    replaceProject(queryClient, project);
    void queryClient.invalidateQueries({
      queryKey: queryKeys.projectWordPressChanges(project.id),
    });
  }

  /** Runs one store operation, leaving a failed one in place for the timeline to show. */
  async function runOperation<T>(
    call: (operationId: string) => Promise<T | null>,
    fallback: string,
  ): Promise<{ value: T } | { error: string }> {
    const store = useWordPressOperationStore.getState();
    if (operationRef.current) store.clear(operationRef.current);
    const id = crypto.randomUUID();
    setOperationId(id);
    const value = await call(id);
    if (value === null) {
      return { error: useWordPressOperationStore.getState().runs[id]?.error ?? fallback };
    }
    store.clear(id);
    setOperationId(null);
    return { value };
  }

  async function addItem(project: Project, item: WpItemRef): Promise<ItemProjectOutcome> {
    let plan: ReturnType<typeof addItemPlan>;
    try {
      plan = addItemPlan(project, siteId, item);
    } catch (error) {
      return { ok: false, error: planError(error) };
    }
    const store = useWordPressOperationStore.getState();
    if (plan.kind === 'items') {
      const { items } = plan;
      const run = await runOperation(
        (id) => store.setProjectItems({ operationId: id, projectId: project.id, items }, siteId),
        `Couldn't add ${item.slug} to ${project.name}.`,
      );
      if ('error' in run) return { ok: false, error: run.error };
      updated(run.value);
      return { ok: true };
    }
    const { items } = plan;
    const run = await runOperation(
      (id) => store.linkProject({ operationId: id, projectId: project.id, siteId, items }),
      `Couldn't link ${project.name} to the site.`,
    );
    if ('error' in run) return { ok: false, error: run.error };
    updated(run.value.project);
    return { ok: true, notPulled: run.value.notPulled };
  }

  async function removeItem(project: Project, item: WpItemRef): Promise<ItemProjectOutcome> {
    let plan: ReturnType<typeof removeItemPlan>;
    try {
      plan = removeItemPlan(project, item);
    } catch (error) {
      return { ok: false, error: planError(error) };
    }
    if (plan.kind === 'items') {
      const { items } = plan;
      const store = useWordPressOperationStore.getState();
      const run = await runOperation(
        (id) => store.setProjectItems({ operationId: id, projectId: project.id, items }, siteId),
        `Couldn't take ${item.slug} out of ${project.name}.`,
      );
      if ('error' in run) return { ok: false, error: run.error };
      updated(run.value);
      return { ok: true };
    }
    // The last item goes with the link. An unlink is quick and has no progress to show.
    try {
      updated(await window.runova.deployWordPress.unlinkProject(project.id));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: wordPressErrorMessage(error) };
    }
  }

  async function whileBusy(work: () => Promise<ItemProjectOutcome>): Promise<ItemProjectOutcome> {
    setBusy(true);
    try {
      return await work();
    } finally {
      setBusy(false);
    }
  }

  return {
    operationId,
    busy,
    add: (project, item) => whileBusy(() => addItem(project, item)),
    remove: (project, item) => whileBusy(() => removeItem(project, item)),
    move: (from, to, item) =>
      whileBusy(async () => {
        const added = await addItem(to, item);
        if (!added.ok) return added;
        const removed = await removeItem(from, item);
        if (removed.ok) return added;
        return {
          ok: false,
          partial: true,
          notPulled: added.notPulled,
          error:
            `Added to ${to.name}, but it's still in ${from.name}. ${removed.error ?? ''}`.trim(),
        };
      }),
    reset: () => {
      if (operationRef.current) useWordPressOperationStore.getState().clear(operationRef.current);
      setOperationId(null);
    },
  };
}
