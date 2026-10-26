import type { DirectTlsStatus } from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Direct TLS (E16) between the main process and the renderer. The pin is a public key hash, not a
 * secret; what matters is that the app only ever takes it from a call made over SSH.
 */

/** What this computer pinned for a server, read over SSH. */
export interface DeployDirectTlsPin {
  /** Whether this computer tries direct TLS first. */
  enabled: boolean;
  port: number;
  /** base64 SHA-256 of the core certificate's SubjectPublicKeyInfo. */
  pin: string;
  pinnedAt: number;
}

export interface DeployDirectTlsInfo {
  /** The core's own account of it, read over SSH just now. */
  status: DirectTlsStatus;
  pinned: DeployDirectTlsPin | null;
  /**
   * The core presents another key than the one pinned here. The app refuses direct TLS until the
   * new pin is accepted (it was read over SSH, so accepting it is safe when the change is expected).
   */
  pinChanged: boolean;
  /** The address the app connects to: the saved server's host. */
  host: string;
}

export interface DeployDirectTlsEnableInput {
  serverId: string;
  port: number;
  /** Addresses or CIDR networks; empty for every address. */
  sources: string[];
  password?: string;
  totpCode?: string;
}
