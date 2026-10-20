import { type FilesErrorCode, filesErrorCode } from '@shared/deployFilesErrors';
import { sshErrorCode, sshErrorMessage } from '@shared/sshErrors';
import { filesProblem } from '@/components/deploy/files/messages';

/**
 * Words for failures in the SFTP file manager (E25). The `[files:*]` codes are shared with
 * Deploy, whose wording talks about deploy folders and plans, so the codes that read wrong here
 * get words of their own and the rest fall back to Deploy's.
 */
const SFTP_WORDS: Partial<Record<FilesErrorCode, string>> = {
  folderMissing: "That folder isn't there anymore. It may have been moved, renamed or deleted.",
  remoteFolderMissing: "That folder doesn't exist on the server.",
  permissionDenied: "Permission denied. This login isn't allowed to do that there.",
  vaultLocked: 'Your saved servers are locked with a passkey. Unlock them, then try again.',
  tooManyFiles: 'That selection holds more than 100,000 files and folders. Pick fewer at a time.',
  localChanged: 'The file changed on this computer while it was being sent. Try again.',
  siteUnknown: "AgentMate doesn't know this server anymore. It may have been removed.",
  exists: 'Something with that name is already there.',
};

/** Codes whose own message from main says more than fixed words could. */
const OWN_MESSAGE: ReadonlySet<FilesErrorCode> = new Set(['server', 'invalidInput']);

/**
 * Why the editor won't open a file, as a toast's title and description, or null when the code
 * is not one of the two refusals. Shared by the store (before it opens the editor) and the
 * editor (when a reload hits the same wall).
 */
export function editRefusal(
  name: string,
  code: FilesErrorCode,
): { title: string; description: string } | null {
  if (code === 'tooLarge') {
    return {
      title: `${name} is too large to edit here`,
      description: 'The editor opens files up to 2 MB. Download it to work on it on this computer.',
    };
  }
  if (code === 'notText') {
    return {
      title: `${name} isn't a text file`,
      description:
        'It holds binary data or text that is not UTF-8, so editing it here could break it.',
    };
  }
  return null;
}

export function sftpProblem(error: unknown): string {
  if (sshErrorCode(error)) return sshErrorMessage(error).trim() || 'Could not connect.';
  const code = filesErrorCode(error);
  if (code && !OWN_MESSAGE.has(code)) {
    const words = SFTP_WORDS[code];
    if (words) return words;
  }
  return filesProblem(error);
}
