import type { FirewallChange } from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The Firewall section's IPC shapes (E13). A change set is previewed, applied over the server's
 * lasting connection with the `$SSH_CONNECTION` read on it, then kept by confirming over a brand
 * new SSH connection, or reverted. A change nobody keeps rolls back on the server by itself.
 */

export interface DeployFirewallChangesInput {
  serverId: string;
  changes: FirewallChange[];
}

export interface DeployFirewallApplyInput extends DeployFirewallChangesInput {
  /** The guard's phrase, typed out, to apply a change it refused. */
  overrideConfirmation?: string;
  /** A step-up on the way, for turning the firewall on or off or overriding the guard. */
  password?: string;
  totpCode?: string;
}

export interface DeployFirewallDecisionInput {
  serverId: string;
  changeSetId: string;
}

export interface DeployFirewallHistoryInput {
  serverId: string;
  limit?: number;
}

export type DeployFirewallOperation = 'apply' | 'confirm' | 'revert';

/** The steps of each operation, in order. */
export type DeployFirewallStep =
  | 'readingConnection'
  | 'applying'
  | 'openingConnection'
  | 'signingIn'
  | 'confirming'
  | 'reverting';

export type DeployFirewallStepState = 'running' | 'done' | 'failed';

/** main -> the main window: one step of an apply, a confirmation or a revert. */
export interface DeployFirewallProgressEvent {
  serverId: string;
  operation: DeployFirewallOperation;
  step: DeployFirewallStep;
  state: DeployFirewallStepState;
  changeSetId?: string;
  message?: string;
  atUnixMs: number;
}
