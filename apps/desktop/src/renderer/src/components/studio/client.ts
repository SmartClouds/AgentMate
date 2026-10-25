import type { Project } from '@agentmat/core';

/**
 * Studio's bridge to its service. The rest of Studio's screens never touch `window.agentmat`
 * directly; they call this, so another host could carry the same calls its own way.
 */
export function studioClient() {
  return window.agentmat.studio;
}

export type StudioClient = ReturnType<typeof studioClient>;

export function studioAiClient() {
  return window.agentmat.studioAi;
}

export type StudioAiClient = ReturnType<typeof studioAiClient>;

export function studioScenesClient() {
  return window.agentmat.studioScenes;
}

export function studioRenderClient() {
  return window.agentmat.studioRender;
}

export function studioMediaClient() {
  return window.agentmat.studioMedia;
}

/** Where a file dropped onto the window is on disk; empty for one that is not a file on disk. */
export function pathForFile(file: File): string {
  return window.agentmat.shell.pathForFile(file);
}

/** The projects AgentMate knows, for choosing which one a video belongs to. */
export async function listProjects(): Promise<Project[]> {
  return (await window.agentmat.projects.list()) ?? [];
}
