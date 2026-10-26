import type {
  ChecklistFix,
  ChecklistStatus,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/** What each status says in words, so it never rests on colour alone. */
export const STATUS_WORD: Record<ChecklistStatus, string> = {
  pass: 'Done',
  warn: 'Worth fixing',
  fail: 'Needs fixing',
  unknown: 'Not checked',
};

/** The button for each fix, named for what it does. */
export const FIX_LABEL: Record<Exclude<ChecklistFix, 'none'>, string> = {
  enableFirewall: 'Turn on the firewall',
  disableSshPasswordLogin: 'Turn off passwords',
  restrictRootLogin: 'Keys only for root',
  enableAutomaticUpdates: 'Turn on',
  reboot: 'Open Overview',
  reviewExposure: 'Review in Firewall',
  renewCertificates: 'Renew now',
  updateCore: 'Update the core',
  enableTwoFactor: 'Turn on two-factor',
};

/** Who may use a fix: the core checks again, this only hides what a role could never do. */
export function fixAllowed(
  fix: ChecklistFix,
  roles: { owner: boolean; admin: boolean },
): { allowed: boolean; why?: string } {
  switch (fix) {
    case 'disableSshPasswordLogin':
    case 'restrictRootLogin':
      return roles.owner
        ? { allowed: true }
        : { allowed: false, why: 'Only an Owner can change how sshd lets people in.' };
    case 'enableTwoFactor':
    case 'reboot':
    case 'reviewExposure':
      return { allowed: true };
    default:
      return roles.admin
        ? { allowed: true }
        : { allowed: false, why: 'Only an Admin or Owner can do this.' };
  }
}
