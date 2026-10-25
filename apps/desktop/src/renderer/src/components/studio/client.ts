import type { Project } from '@agentmat/core';

/**
 * Studio's bridge to its service. The rest of Studio's screens never touch `window.agentmat`
 * directly; they call this, so another host could carry the same calls its own way.
 */
export function studioClient() {
  return window.agentmat.studio;
}

export type StudioClient = ReturnType<typeof studioClient>;

/** The projects AgentMate knows, for choosing which one a video belongs to. */
export async function listProjects(): Promise<Project[]> {
  return (await window.agentmat.projects.list()) ?? [];
}
