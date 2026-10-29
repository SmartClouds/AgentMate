import { coreErrorMessage } from '@shared/coreErrors';
import type { JobInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployStackUploadProgress, DeployStackUploadResult } from '@shared/deployStacksTypes';
import { create } from 'zustand';
import type { WizardSource, WizardStep } from '@/components/deploy/apps/wizard/types';
import { useDeployAppEnvFilesStore } from './deployAppEnvFilesStore';

/**
 * The New App wizard's draft and its deploy (E07 T7), per server and app. The upload, the
 * server's findings and the deploy run from here rather than from the wizard, so leaving the
 * Deploy page neither loses how far it got nor strands a step that waits for the user.
 */

export type AppRun =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'invalid'; result: DeployStackUploadResult }
  | { phase: 'confirm'; result: DeployStackUploadResult }
  | { phase: 'starting'; result: DeployStackUploadResult }
  | { phase: 'running'; result: DeployStackUploadResult; job: JobInfo }
  | { phase: 'error'; message: string; result?: DeployStackUploadResult };

/** What the wizard has picked so far, kept so it opens again on the same step. */
export interface AppWizardDraft {
  step: WizardStep;
  reached: number;
  source: WizardSource;
  nameTouched: boolean;
  /** Undefined until the first preview says which services stay private. */
  proxied: string[] | undefined;
  acknowledged: ReadonlySet<string>;
  /** The findings the server added on top, accepted in the deploy step. */
  serverAcknowledged: ReadonlySet<string>;
}

export interface AppWizard {
  draft: AppWizardDraft;
  run: AppRun;
  progress: DeployStackUploadProgress | null;
  /** The app's name as it was sent, for a notice elsewhere in the Apps section. */
  name: string;
  /** Set once a deploy starts; the server the files went to. */
  serverId: string | null;
}

export interface AppDeployInput {
  serverId: string;
  /** Deploy this app again as a new revision; null for a new app. */
  existingStackId: string | null;
  name: string;
  projectId: string;
  composePath: string;
  environmentId: string | null;
  /** Null uses every file of the environment. */
  envFileIds: string[] | null;
  proxiedServices: string[];
  acknowledgedRisks: string[];
}

export function wizardKey(serverId: string, existingStackId: string | null): string {
  return `${serverId}:${existingStackId ?? 'new'}`;
}

export function emptyDraft(overrides: Partial<AppWizardDraft> = {}): AppWizardDraft {
  return {
    step: 'source',
    reached: 0,
    source: {
      projectId: '',
      projectName: '',
      projectFolder: '',
      composePath: '',
      environmentId: null,
      environmentName: null,
      envFileIds: null,
      name: '',
    },
    nameTouched: false,
    proxied: undefined,
    acknowledged: new Set(),
    serverAcknowledged: new Set(),
    ...overrides,
  };
}

/** True while the wizard's deploy is on its way and nothing waits for the user. */
export function isAppRunBusy(run: AppRun): boolean {
  return run.phase === 'uploading' || run.phase === 'starting';
}

interface DeployAppRunState {
  wizards: Record<string, AppWizard>;
  /** Starts a wizard with `draft`, unless one is already kept under `key`. */
  open: (key: string, draft: AppWizardDraft) => void;
  setDraft: (key: string, change: Partial<AppWizardDraft>) => void;
  setRun: (key: string, run: AppRun) => void;
  /** Sends the files, then deploys, unless the server turns them down or finds more to accept. */
  startDeploy: (key: string, input: AppDeployInput, onSettled?: () => void) => Promise<void>;
  /** Accepts what the server found, if anything, and deploys a revision already uploaded. */
  launch: (
    key: string,
    result: DeployStackUploadResult,
    accept?: readonly string[],
    onSettled?: () => void,
  ) => Promise<void>;
  reset: (key: string) => void;
}

export const useDeployAppRunStore = create<DeployAppRunState>((set, get) => {
  const patch = (key: string, change: (wizard: AppWizard) => Partial<AppWizard>): void =>
    set((state) => {
      const wizard = state.wizards[key];
      return wizard
        ? { wizards: { ...state.wizards, [key]: { ...wizard, ...change(wizard) } } }
        : state;
    });

  return {
    wizards: {},
    open: (key, draft) =>
      set((state) =>
        state.wizards[key]
          ? state
          : {
              wizards: {
                ...state.wizards,
                [key]: {
                  draft,
                  run: { phase: 'idle' },
                  progress: null,
                  name: draft.source.name,
                  serverId: null,
                },
              },
            },
      ),
    setDraft: (key, change) => patch(key, (wizard) => ({ draft: { ...wizard.draft, ...change } })),
    setRun: (key, run) => patch(key, () => ({ run })),
    startDeploy: async (key, input, onSettled) => {
      const current = get().wizards[key];
      if (!current || isAppRunBusy(current.run)) return;
      patch(key, (wizard) => ({
        run: { phase: 'uploading' },
        progress: null,
        name: input.name,
        serverId: input.serverId,
        draft: { ...wizard.draft, step: 'deploy', reached: Math.max(wizard.draft.reached, 4) },
      }));
      // The upload's progress names only the server, so it is followed while this upload runs.
      const stop = window.runova.deployStacks.onUploadProgress((event) => {
        if (event.serverId === input.serverId) patch(key, () => ({ progress: event }));
      });
      const { existingStackId, name, envFileIds, ...rest } = input;
      // Left out when every file applies, the way the main process reads it.
      const common = envFileIds ? { ...rest, envFileIds } : rest;
      let result: DeployStackUploadResult;
      try {
        result = existingStackId
          ? await window.runova.deployStacks.upload({ ...common, stackId: existingStackId })
          : await window.runova.deployStacks.create({ ...common, name });
      } catch (error) {
        patch(key, () => ({ run: { phase: 'error', message: coreErrorMessage(error) } }));
        return;
      } finally {
        stop();
      }
      useDeployAppEnvFilesStore
        .getState()
        .remember(input.serverId, result.stack.id, input.environmentId, envFileIds);
      onSettled?.();
      if (result.revision.state === 'invalid') {
        patch(key, () => ({ run: { phase: 'invalid', result } }));
      } else if (result.revision.unacknowledgedRisks.length > 0) {
        patch(key, (wizard) => ({
          run: { phase: 'confirm', result },
          draft: { ...wizard.draft, serverAcknowledged: new Set() },
        }));
      } else {
        await get().launch(key, result, [], onSettled);
      }
    },
    launch: async (key, result, accept = [], onSettled) => {
      const serverId = get().wizards[key]?.serverId;
      if (!serverId) return;
      patch(key, () => ({ run: { phase: 'starting', result } }));
      try {
        if (accept.length > 0) {
          await window.runova.deployStacks.acknowledge({
            serverId,
            stackId: result.stack.id,
            revision: result.revision.number,
            riskIds: [...accept],
          });
        }
        const job = await window.runova.deployStacks.deploy({
          serverId,
          stackId: result.stack.id,
          revision: result.revision.number,
        });
        patch(key, () => ({ run: { phase: 'running', result, job } }));
        onSettled?.();
      } catch (error) {
        patch(key, () => ({ run: { phase: 'error', message: coreErrorMessage(error), result } }));
      }
    },
    reset: (key) =>
      set((state) => {
        const { [key]: _gone, ...rest } = state.wizards;
        return { wizards: rest };
      }),
  };
});
