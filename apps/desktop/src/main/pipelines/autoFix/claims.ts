/**
 * Lets the pipeline watcher ask whether CI auto-fix took on a failed run, without importing the
 * auto-fix service and everything it starts. The service registers itself at startup.
 */
let claimer: ((projectId: string, runId: number) => boolean) | null = null;

export function setAutoFixClaimer(next: ((projectId: string, runId: number) => boolean) | null) {
  claimer = next;
}

/** True when an auto-fix session is handling (or handled) this run's failure. */
export function autoFixClaims(projectId: string, runId: number): boolean {
  return claimer?.(projectId, runId) ?? false;
}
