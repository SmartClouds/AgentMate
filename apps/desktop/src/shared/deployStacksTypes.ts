import type { ComposePortBinding, ComposeRisk } from '@runova/core';
import type {
  StackAction,
  StackInfo,
  StackRevisionInfo,
} from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The Apps of a Deploy server (E07): compose stacks built from a project's compose file and an
 * environment from its Environments tab. The renderer only ever sees env keys; the values are
 * read, rendered into the .env and sent to the core by the main process.
 */

/** A compose file found in a project, relative to the project folder with forward slashes. */
export interface DeployComposeFile {
  path: string;
  /** How many services it has, when it could be read. */
  services: number | null;
  /** Why it could not be read, when it could not. */
  error?: string;
}

export interface DeployComposeDiscovery {
  projectId: string;
  projectName: string;
  files: DeployComposeFile[];
  /** The index stopped early, so a file may be missing from the list. */
  truncated: boolean;
}

/** What the wizard picked, enough to read the files again. */
export interface DeployStackSourceInput {
  projectId: string;
  /** Relative to the project folder, as discovery listed it. */
  composePath: string;
  /** Null deploys without a .env. */
  environmentId: string | null;
}

export interface DeployStackPreviewInput extends DeployStackSourceInput {
  /** Services kept on 127.0.0.1. Left out: every service that publishes a port. */
  proxiedServices?: string[];
  /** The server enforces SELinux, so bind mounts need :z or :Z (from the server's facts). */
  selinuxEnforcing?: boolean;
}

export interface DeployStackServicePreview {
  name: string;
  image: string | null;
  /** The service has `build:`, so a build context goes with the upload. */
  builds: boolean;
  /** Ports as the compose file publishes them. */
  ports: ComposePortBinding[];
  /** Whether it publishes anything at all (only those can be kept private). */
  publishes: boolean;
  /** `network_mode: host`: it cannot be kept on 127.0.0.1. */
  hostNetwork: boolean;
}

export interface DeployStackPreview {
  projectName: string;
  composePath: string;
  /** The compose file's own `name:`, a suggestion for the app's name. */
  composeName: string | null;
  services: DeployStackServicePreview[];
  /** The keys the .env will hold, never the values. */
  envKeys: string[];
  /** The environment's files the keys come from, in the order they apply. */
  envFiles: string[];
  /** Variables the compose file uses that the environment does not set. */
  missingVariables: string[];
  /** Services kept on 127.0.0.1 (the default: all that publish and can be). */
  proxiedServices: string[];
  /** Every published port once the loopback override applies. */
  bindings: ComposePortBinding[];
  /** The override file the core writes for the proxied services. */
  overrideText: string;
  /** Every finding, worst first. */
  risks: ComposeRisk[];
  /** The findings that need an acknowledgment before a deploy (all but low ones). */
  requiresAcknowledgment: string[];
  /** Why a build context goes with the upload, or null when none does. */
  buildContext: string | null;
  /** Why it cannot be deployed as it is (a file that does not parse, a key that cannot be written). */
  blocking: string | null;
}

export interface DeployStackCreateInput extends DeployStackSourceInput {
  serverId: string;
  /** The app's name on the server (a compose project name). */
  name: string;
  proxiedServices: string[];
  acknowledgedRisks: string[];
}

/** A new revision of an existing app, from the same kind of source. */
export interface DeployStackRevisionInput extends DeployStackSourceInput {
  serverId: string;
  stackId: string;
  proxiedServices: string[];
  acknowledgedRisks: string[];
}

export interface DeployStackUploadResult {
  stack: StackInfo;
  /** Ready to deploy unless the core found risks still waiting for an acknowledgment. */
  revision: StackRevisionInfo;
}

export interface DeployStackRef {
  serverId: string;
  stackId: string;
}

export interface DeployStackRevisionRef extends DeployStackRef {
  revision: number;
}

export interface DeployStackAcknowledgeInput extends DeployStackRevisionRef {
  riskIds: string[];
}

export interface DeployStackActionInput extends DeployStackRef {
  action: StackAction;
}

export interface DeployStackDeleteInput extends DeployStackRef {
  /** The app's volumes go too: its data. Admin only. */
  removeVolumes: boolean;
}

/** Where an upload is, for the wizard's progress line. */
export interface DeployStackUploadProgress {
  serverId: string;
  phase: 'reading' | 'packing' | 'uploading-files' | 'uploading-context' | 'done';
  /** For the build context: bytes sent so far and in all. */
  sentBytes?: number;
  totalBytes?: number;
}
