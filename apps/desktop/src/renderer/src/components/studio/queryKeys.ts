/** Studio's own query keys, under one prefix so a single invalidate refreshes everything. */
export const studioKeys = {
  all: ['studio'] as const,
  settings: ['studio', 'settings'] as const,
  videos: ['studio', 'videos'] as const,
  /** Undefined lists every video, null the standalone ones, an id that project's. */
  videoList: (projectId: string | null | undefined) =>
    [
      'studio',
      'videos',
      projectId === undefined ? 'all' : projectId === null ? 'standalone' : projectId,
    ] as const,
  projectStorage: (projectId: string) => ['studio', 'project-storage', projectId] as const,
  rootCheck: (path: string, projectId: string | null) =>
    ['studio', 'root-check', projectId, path] as const,
  history: (videoId: string) => ['studio', 'history', videoId] as const,
  generations: (videoId: string) => ['studio', 'generations', videoId] as const,
  generationDetail: (videoId: string, generationId: string) =>
    ['studio', 'generations', videoId, generationId] as const,
  recipes: ['studio', 'recipes'] as const,
  thumbnail: (videoId: string, treeHash: string | null) =>
    ['studio', 'thumbnail', videoId, treeHash] as const,
  sceneCode: (videoId: string, sceneId: string) =>
    ['studio', 'scene-code', videoId, sceneId] as const,
  styleReference: (styleId: string, aspect: string, language: string) =>
    ['studio', 'style-reference', styleId, aspect, language] as const,
  renderTools: ['studio', 'render-tools'] as const,
  /** Keyed by the video's edit number, so any edit asks again. */
  renderEstimate: (videoId: string, seq: number) =>
    ['studio', 'render-estimate', videoId, seq] as const,
  renders: ['studio', 'renders'] as const,
  media: (videoId: string) => ['studio', 'media', videoId] as const,
  peaks: (videoId: string, hash: string) => ['studio', 'peaks', videoId, hash] as const,
  /** Undefined for every video's renders. */
  renderList: (videoId: string | undefined) => ['studio', 'renders', videoId ?? 'all'] as const,
};
