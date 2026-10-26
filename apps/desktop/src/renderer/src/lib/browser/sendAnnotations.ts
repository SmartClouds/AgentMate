import { getCliDefinition, type Project } from '@runova/core';
import { toast } from 'sonner';
import { type DeliverOptions, deliverToAgent } from '@/lib/workspace/agentSend';
import { useBrowserStore } from '@/stores/browserStore';
import { elementLabel, formatAnnotationsPrompt, formatElementContext } from './annotationPrompt';
import type { PickPayload } from './types';

/** Getting the comments left in a browser tab to an agent, or onto the clipboard. */

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Types every comment of the tab into an agent CLI as one prompt. The comments are cleared once
 * the CLI has them (or a new tab is starting with them); if they only made it to the clipboard
 * they stay, so nothing is lost. Returns whether they were sent.
 */
export async function sendAnnotations(
  project: Project,
  tabId: string,
  target?: DeliverOptions['target'],
): Promise<boolean> {
  const annotations = useBrowserStore.getState().annotations[tabId] ?? [];
  if (annotations.length === 0) return false;
  const result = await deliverToAgent(project, {
    build: () => formatAnnotationsPrompt(annotations),
    what: 'Your comments',
    target,
  });
  if (!result || result.outcome === 'clipboard') return false;

  useBrowserStore.getState().removeAnnotations(
    tabId,
    annotations.map((one) => one.id),
  );
  const cli = getCliDefinition(result.cliId)?.name ?? 'the agent';
  const them = annotations.length === 1 ? 'it' : 'them';
  toast.success(`Sent ${plural(annotations.length, 'comment')} to ${cli}`, {
    description:
      result.outcome === 'launched'
        ? `They go in as soon as ${cli} is ready. Press Enter there to send ${them}.`
        : `Press Enter in the terminal to send ${them}.`,
  });
  return true;
}

export async function copyAnnotations(tabId: string): Promise<void> {
  const annotations = useBrowserStore.getState().annotations[tabId] ?? [];
  if (annotations.length === 0) return;
  await navigator.clipboard.writeText(formatAnnotationsPrompt(annotations));
  toast.success(`Copied ${plural(annotations.length, 'comment')}`);
}

/** Puts one element's details on the clipboard, for pasting into any chat. */
export async function copyElementContext(payload: PickPayload): Promise<void> {
  await navigator.clipboard.writeText(formatElementContext(payload));
  toast.success(`Copied ${elementLabel(payload.element)}`, {
    description: 'Paste it into your agent to ask about it.',
  });
}
