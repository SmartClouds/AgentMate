import type { Project } from '@runova/core';

/**
 * Studio's bridge to its service. The rest of Studio's screens never touch `window.runova`
 * directly; they call this, so another host could carry the same calls its own way.
 */
export function studioClient() {
  return window.runova.studio;
}

export type StudioClient = ReturnType<typeof studioClient>;

export function studioAiClient() {
  return window.runova.studioAi;
}

export type StudioAiClient = ReturnType<typeof studioAiClient>;

export function studioScenesClient() {
  return window.runova.studioScenes;
}

export function studioRenderClient() {
  return window.runova.studioRender;
}

export function studioMediaClient() {
  return window.runova.studioMedia;
}

export function studioAudioClient() {
  return window.runova.studioAudio;
}

export function studioGenClient() {
  return window.runova.studioGen;
}

/** Where a file dropped onto the window is on disk; empty for one that is not a file on disk. */
export function pathForFile(file: File): string {
  return window.runova.shell.pathForFile(file);
}

/** The projects Runova knows, for choosing which one a video belongs to. */
export async function listProjects(): Promise<Project[]> {
  return (await window.runova.projects.list()) ?? [];
}
