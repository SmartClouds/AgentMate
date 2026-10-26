import type { ToastHistoryLink } from '@/stores/toastHistoryStore';

/** `https://github.com/owner/repo/actions/runs/123` to the route the Pipelines page deep-links on. */
export function pipelineRunRoute(htmlUrl: string | null): string | null {
  const match = htmlUrl?.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/);
  if (!match) return null;
  return `/pipelines?run=${match[2]}&repo=${encodeURIComponent(match[1])}`;
}

/**
 * Follow a message's link. A page in the app wins over an outside URL, so a pipeline run
 * opens on the Pipelines page (which scrolls to it and blinks the row) rather than GitHub.
 */
export function openMessageLink(link: ToastHistoryLink, navigate: (route: string) => void): void {
  if (link.notificationId) void window.runova.appNotifications.markRead(link.notificationId);
  if (link.route) navigate(link.route);
  else if (link.url) void window.runova.shell.openExternal(link.url);
}
