import type { RegistryCredentialInfo } from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Private registries (E08). Sign-ins kept on this computer go with each deploy and live on the
 * server only for that job; a credential can also be stored on a server for pulls nobody is
 * there for. No type here carries a secret back to the renderer.
 */

/** What a sign-in on this computer is for. */
export type DeployRegistryKind = 'github' | 'dockerhub' | 'custom';

/**
 * Where the secret came from: a GitHub token made for packages only (the default), the GitHub
 * CLI's own sign-in (broad scopes, behind a warning), or a user name and token or password.
 */
export type DeployRegistrySource = 'packagesToken' | 'ghCli' | 'password';

/** A sign-in kept on this computer, as the renderer sees it (never the secret). */
export interface DeployRegistryCredential {
  id: string;
  kind: DeployRegistryKind;
  source: DeployRegistrySource;
  /** The registry host: ghcr.io, docker.io or a custom one such as registry.example.com:5000. */
  registry: string;
  username: string;
  /** GitHub's X-OAuth-Scopes at the last check; null for other registries. */
  scopes: string[] | null;
  /** Scopes beyond read:packages the person accepted when saving. */
  broaderScopes: string[];
  savedAt: number;
  checkedAt: number | null;
  /** The Servers passkey is set and locked, so the secret cannot go with a deploy right now. */
  locked: boolean;
}

/** A GitHub token pasted into the app. */
export interface DeployGithubTokenInput {
  token: string;
  /** The person read the warning about the token's broader scopes and wants it anyway. */
  acceptBroaderScopes: boolean;
}

/** Use the GitHub CLI's sign-in (`gh auth token`). Always broader than packages, so always accepted explicitly. */
export interface DeployGithubCliInput {
  acceptBroaderScopes: boolean;
}

/** Docker Hub or a custom registry: a user name and a token (or password). */
export interface DeployRegistryCredentialInput {
  kind: 'dockerhub' | 'custom';
  /** Required for custom; Docker Hub is always docker.io. */
  registry?: string;
  username: string;
  secret: string;
}

/** What GitHub says a token can do, before anything is saved. */
export interface DeployGithubTokenCheck {
  username: string | null;
  scopes: string[];
  /** read:packages (or write:packages) is there. */
  canPull: boolean;
  /** Every scope beyond read:packages. */
  broaderScopes: string[];
  /** Why it cannot be used, with the fix, in plain words. */
  problem: string | null;
}

/** The GitHub CLI's sign-in, checked the same way. */
export interface DeployGithubCliStatus extends DeployGithubTokenCheck {
  /** gh is installed and signed in to github.com. */
  available: boolean;
}

/** Whether an app's deploys send this computer's sign-ins (on unless turned off). */
export interface DeployAppRegistryChoice {
  serverId: string;
  stackId: string;
  sendSignIns: boolean;
}

/** For one registry an app pulls from: what will sign in to it on the next deploy. */
export interface DeployRegistryPlanEntry {
  registry: string;
  /** The sign-in from this computer that goes with the deploy, or null. */
  credentialId: string | null;
  /** The server has a stored credential for this registry. */
  storedOnServer: boolean;
}

/** Which registries an app pulls from: a revision on the server, or the images of a preview. */
export interface DeployRegistryPlanInput {
  serverId: string;
  stackId?: string | null;
  revision?: number | null;
  images?: string[] | null;
}

export interface DeployRegistryPlan {
  sendSignIns: boolean;
  entries: DeployRegistryPlanEntry[];
}

/** The password or authenticator code a step-up needs, when the core asked for one. */
export interface DeployRegistryProof {
  password?: string;
  totpCode?: string;
}

/** Stores a credential on a server: typed in, or copied from a sign-in on this computer. */
export type DeployServerCredentialInput = DeployRegistryProof &
  (
    | { serverId: string; registry: string; username: string; secret: string }
    | { serverId: string; credentialId: string }
  );

export interface DeployServerCredentialRemoveInput extends DeployRegistryProof {
  serverId: string;
  credentialId: string;
}

export type DeployServerCredential = RegistryCredentialInfo;
