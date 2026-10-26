import type {
  ChecklistItem,
  SecurityChecklist,
  SshHardeningChangeInfo,
  SshHardeningPreview,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/** A checklist as the core sends one for a fresh VPS, for the Security center's tests. */

function item(
  fields: Partial<ChecklistItem> & Pick<ChecklistItem, 'id' | 'title' | 'status'>,
): ChecklistItem {
  return { weight: 2, detail: `${fields.title} detail.`, fix: 'none', targets: [], ...fields };
}

export const ITEMS: ChecklistItem[] = [
  item({ id: 'firewall', title: 'Firewall on', status: 'fail', weight: 3, fix: 'enableFirewall' }),
  item({
    id: 'ssh-passwords',
    title: 'SSH password login off',
    status: 'fail',
    weight: 3,
    fix: 'disableSshPasswordLogin',
  }),
  item({
    id: 'ssh-root',
    title: 'Root signs in with a key only',
    status: 'warn',
    fix: 'restrictRootLogin',
  }),
  item({
    id: 'auto-updates',
    title: 'Automatic security updates',
    status: 'fail',
    fix: 'enableAutomaticUpdates',
  }),
  item({ id: 'reboot', title: 'No reboot waiting', status: 'pass', weight: 1 }),
  item({
    id: 'exposure',
    title: 'No unexpected public ports',
    status: 'warn',
    fix: 'reviewExposure',
    targets: ['3000/tcp'],
  }),
  item({
    id: 'certificates',
    title: 'Certificates healthy',
    status: 'warn',
    fix: 'renewCertificates',
    targets: ['blog'],
  }),
  item({
    id: 'core-version',
    title: 'Server core up to date',
    status: 'warn',
    weight: 1,
    fix: 'updateCore',
    targets: ['1.54.0'],
  }),
  item({ id: 'owners-2fa', title: 'Two-factor for every Owner', status: 'unknown' }),
];

export const CHECKLIST: SecurityChecklist = {
  score: 31,
  items: ITEMS,
  ssh: {
    passwordLogin: true,
    keyboardInteractiveLogin: false,
    keyLogin: true,
    rootLogin: 'yes',
    managedByRunova: false,
  },
  coreVersion: '1.53.0',
  checkedAtUnixMs: Date.now(),
};

export const PREVIEW: SshHardeningPreview = {
  summary: 'SSH password login off',
  path: '/etc/ssh/sshd_config.d/00-runova.conf',
  content: '# Written by Runova\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n',
  commands: [
    'write /etc/ssh/sshd_config.d/00-runova.conf',
    'sshd -t',
    'sshd -T',
    'systemctl reload ssh',
  ],
  proof: { keyLoginProven: true, explanation: 'This connection signed in as root with a key.' },
  allowed: true,
  confirmWithinSeconds: 60,
  notes: ['Connections open now stay open.'],
};

export function change(fields: Partial<SshHardeningChangeInfo> = {}): SshHardeningChangeInfo {
  const now = Date.now();
  return {
    id: '00000000-0000-4000-9000-000000000001',
    state: 'awaitingConfirmation',
    summary: 'SSH password login off',
    createdAtUnixMs: now,
    deadlineUnixMs: now + 60_000,
    requestedBy: 'maria',
    ...fields,
  };
}
