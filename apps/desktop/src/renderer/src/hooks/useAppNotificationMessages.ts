import type { AppNotification, PipelineFailureOpen } from '@runova/core';
import { isPipelineFailureOpen } from '@runova/core';
import { workspacePipelinesRoute } from '@shared/pet';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { openMessageLink, pipelineRunRoute } from '@/lib/messageLink';
import { showLinkedToast } from '@/lib/toastHistory';
import type { ToastHistoryKind, ToastHistoryLink } from '@/stores/toastHistoryStore';

const KIND: Record<AppNotification['kind'], { kind: ToastHistoryKind; tag?: string }> = {
  'pipeline-failure': { kind: 'error', tag: 'Failed' },
  'pipeline-success': { kind: 'success', tag: 'Passed' },
  'tool-update-available': { kind: 'info' },
  'deploy-critical': { kind: 'error', tag: 'Critical' },
  'deploy-warning': { kind: 'warning', tag: 'Warning' },
  'deploy-info': { kind: 'info' },
  'health-failure': { kind: 'error', tag: 'Down' },
  'health-recovered': { kind: 'success', tag: 'Recovered' },
  'relay-attention': { kind: 'warning', tag: 'Relay' },
  'relay-finished': { kind: 'success', tag: 'Relay' },
};

/** A page inside the app; anything else in `route` is ignored rather than followed. */
export function appRoute(item: AppNotification): string | null {
  if (item.route?.startsWith('/') && !item.route.startsWith('//')) return item.route;
  return pipelineRunRoute(item.htmlUrl);
}

/**
 * Where a pipeline failure's alert goes on click. The Pipelines page unless the user chose
 * otherwise, and also when the setting cannot be read, so a failed read never costs the way in.
 */
async function failureClickTarget(): Promise<PipelineFailureOpen> {
  try {
    const settings = await window.runova.settings.get();
    return isPipelineFailureOpen(settings.pipelineFailureOpen)
      ? settings.pipelineFailureOpen
      : 'pipelines';
  } catch {
    return 'pipelines';
  }
}

/**
 * The route a failure's alert opens: that project's Workspace when asked for and the alert knows
 * its project, otherwise the page the item itself points at (the run on the Pipelines page).
 */
function failureRoute(item: AppNotification, target: PipelineFailureOpen): string | null {
  if (target === 'workspace' && item.projectId) return workspacePipelinesRoute(item.projectId);
  return appRoute(item);
}

/**
 * Turns inbox entries (pipeline results, CLI updates, server alerts) into in-app messages: a
 * toast when one arrives, and a row in Recent messages after. What was already in the inbox at
 * startup is left alone, only entries that show up while the app is open are announced.
 */
export function useAppNotificationMessages(): void {
  const navigate = useNavigate();

  useEffect(() => {
    let disposed = false;
    let primed = false;
    const seen = new Set<string>();
    // One sync at a time, so a change landing mid-load cannot announce an entry twice.
    let chain: Promise<void> = Promise.resolve();

    async function sync(): Promise<void> {
      const items = await window.runova.appNotifications.list();
      if (disposed) return;
      const fresh = items.filter((item) => !seen.has(item.id));
      for (const item of items) seen.add(item.id);
      if (!primed) {
        primed = true;
        return;
      }
      const target = fresh.some((item) => item.kind === 'pipeline-failure')
        ? await failureClickTarget()
        : 'pipelines';
      if (disposed) return;
      // The inbox is newest first; announce oldest first so the newest ends up on top.
      for (const item of fresh.reverse()) announce(item, target);
    }

    function announce(item: AppNotification, failureTarget: PipelineFailureOpen): void {
      const style = KIND[item.kind] ?? KIND['tool-update-available'];
      const base = {
        kind: style.kind,
        title: item.title,
        description: item.body,
        projectId: item.projectId,
        projectName: item.projectName,
        tag: style.tag,
      };
      const failure = item.kind === 'pipeline-failure';
      // The user can turn off opening a failure from its alert. The message still shows, it
      // just has no Open button and no link for its row in Recent messages.
      if (failure && failureTarget === 'none') {
        showLinkedToast(base);
        return;
      }
      const route = failure ? failureRoute(item, failureTarget) : appRoute(item);
      const link: ToastHistoryLink = { notificationId: item.id };
      if (route) link.route = route;
      else if (item.htmlUrl) link.url = item.htmlUrl;
      showLinkedToast({ ...base, link }, () => openMessageLink(link, navigate));
    }

    const run = (): void => {
      chain = chain.then(sync).catch(() => undefined);
    };
    run();
    const stop = window.runova.appNotifications.onChanged(run);
    return () => {
      disposed = true;
      stop();
    };
  }, [navigate]);
}
