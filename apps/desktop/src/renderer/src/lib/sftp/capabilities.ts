import type { SftpCapabilities, SftpSessionInfo } from '@shared/sftpTypes';

/**
 * What the remote side of a file manager session lets the user do (E27). A saved server's disk
 * over SFTP allows everything, and a session that says nothing counts as that. A container that
 * is stopped or has no shell turns rename, delete, chmod and edit off, with a sentence for why.
 */

export type SftpAction = keyof SftpCapabilities;

type SessionLike = Pick<SftpSessionInfo, 'capabilities' | 'limitation'> | null | undefined;

export function allowed(session: SessionLike, action: SftpAction): boolean {
  return session?.capabilities?.[action] ?? true;
}

/** The session's sentence about what it cannot do, or null when it has none. */
export function limitationOf(session: SessionLike): string | null {
  const text = session?.limitation?.trim();
  return text ? text : null;
}

const PLAIN_REFUSAL: Record<SftpAction, string> = {
  rename: "Renaming isn't possible here.",
  remove: "Deleting isn't possible here.",
  chmod: "Changing permissions isn't possible here.",
  edit: "Editing in place isn't possible here.",
};

/** Why `action` is off, for a tooltip or a toast; null when it is allowed. */
export function refusalFor(session: SessionLike, action: SftpAction): string | null {
  if (allowed(session, action)) return null;
  return limitationOf(session) ?? PLAIN_REFUSAL[action];
}
