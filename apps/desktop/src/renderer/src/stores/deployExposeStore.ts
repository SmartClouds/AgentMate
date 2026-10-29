import { create } from 'zustand';
import {
  type ExposeOutcome,
  type ExposeRequest,
  type ExposeStep,
  exposeOnDomain,
  initialExposeSteps,
  withStep,
} from '@/lib/deploy/sites/expose';

/**
 * Putting a port of a server on a domain (the site, nginx, the certificate), per server and port.
 * The steps run from here rather than from the dialog, so closing it or leaving the Deploy page
 * does not lose how far they got.
 */

export interface ExposeRun {
  domain: string;
  certificate: boolean;
  steps: ExposeStep[];
  phase: 'working' | 'done' | 'failed';
}

export function exposeKey(serverId: string, route: string): string {
  return `${serverId}:${route}`;
}

interface DeployExposeState {
  runs: Record<string, ExposeRun>;
  /** Resolves with how it ended, or null when a run for `key` was already working. */
  expose: (
    key: string,
    request: ExposeRequest,
    onSettled?: () => void,
  ) => Promise<ExposeOutcome | null>;
  clear: (key: string) => void;
}

export const useDeployExposeStore = create<DeployExposeState>((set, get) => {
  const patch = (key: string, change: (run: ExposeRun) => Partial<ExposeRun>): void =>
    set((state) => {
      const run = state.runs[key];
      return run ? { runs: { ...state.runs, [key]: { ...run, ...change(run) } } } : state;
    });

  return {
    runs: {},
    expose: async (key, request, onSettled) => {
      if (get().runs[key]?.phase === 'working') return null;
      set((state) => ({
        runs: {
          ...state.runs,
          [key]: {
            domain: request.domain,
            certificate: request.certificate,
            steps: initialExposeSteps(),
            phase: 'working',
          },
        },
      }));
      const outcome = await exposeOnDomain(request, (id, next) =>
        patch(key, (run) => ({ steps: withStep(run.steps, id, next) })),
      );
      patch(key, () => ({ phase: outcome.ok ? 'done' : 'failed' }));
      onSettled?.();
      return outcome;
    },
    clear: (key) =>
      set((state) => {
        const { [key]: _gone, ...rest } = state.runs;
        return { runs: rest };
      }),
  };
});
