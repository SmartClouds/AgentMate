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
};
