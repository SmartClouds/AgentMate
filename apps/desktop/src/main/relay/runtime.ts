import type {
  RelayApplyResult,
  RelayMcpProposal,
  RelayRunView,
  RelayStartInput,
  RelayStartResult,
} from '../../shared/relayTypes';

/**
 * What runs relays: the driver that feeds the core reducer and starts sessions. The IPC handlers
 * reach it through here, so they do not depend on how it is built or when it starts.
 */
export interface RelayRuntime {
  start(input: RelayStartInput): Promise<RelayStartResult>;
  pause(relayId: string): Promise<void>;
  resume(relayId: string): Promise<void>;
  cancel(relayId: string): Promise<void>;
  markDone(relayId: string, taskId: string): Promise<void>;
  /** Every relay of a project, newest first. */
  runs(projectId: string): RelayRunView[];
  /** The relay waiting, running or paused on a project, if any. */
  active(projectId: string): RelayRunView | null;
  /** The leg tabs the renderer has after a reload, so no leg is launched twice. */
  reconcile(tabs: { legId: string; tabId: string }[]): Promise<void>;
  pendingProposals(): RelayMcpProposal[];
  decideProposal(proposalId: string, accept: boolean): Promise<RelayApplyResult | null>;
}

let runtime: RelayRuntime | null = null;

export function setRelayRuntime(next: RelayRuntime | null): void {
  runtime = next;
}

export function getRelayRuntime(): RelayRuntime | null {
  return runtime;
}
