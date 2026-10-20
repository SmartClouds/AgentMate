import type { SftpBridge } from '@shared/sftpTypes';

/**
 * The SFTP part of the preload bridge, read on every call so tests can swap `window.agentmat`
 * between renders. Typed as `SftpBridge` so the file manager depends on the shared contract,
 * not on how the preload builds it.
 */
export function sftpBridge(): SftpBridge {
  return window.agentmat.sftp;
}
