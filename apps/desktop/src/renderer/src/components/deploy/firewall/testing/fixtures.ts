import type {
  ExposureInventory,
  FirewallChangePreview,
  FirewallChangeSetInfo,
  FirewallPreset,
  FirewallRuleInfo,
  FirewallStatus,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/** A ufw server with SSH, the web and a database open, for the Firewall section's tests. */

export const CHANGE_ID = '00000000-0000-4000-9000-000000000001';

const rule = (fields: Partial<FirewallRuleInfo> & { id: string }): FirewallRuleInfo => ({
  action: 'allow',
  protocol: 'tcp',
  families: 'both',
  description: '',
  editable: true,
  outgoing: false,
  ...fields,
});

export const RULES: FirewallRuleInfo[] = [
  rule({ id: 'r1', port: 22, comment: 'ssh' }),
  rule({ id: 'r2', port: 443 }),
  rule({ id: 'r3', port: 5432, source: '10.0.0.0/8', comment: 'app servers' }),
  rule({
    id: 'r4',
    action: 'deny',
    protocol: 'any',
    source: '198.51.100.23',
    families: 'ipv4',
    editable: false,
    note: 'Added by hand with a rule this app does not edit.',
  }),
];

export function status(fields: Partial<FirewallStatus> = {}): FirewallStatus {
  return {
    backend: 'ufw',
    installed: true,
    active: true,
    defaultIncoming: 'deny',
    defaultOutgoing: 'allow',
    ipv6: true,
    rules: RULES,
    warnings: [],
    ssh: { ports: [22] },
    confirmWithinSeconds: 60,
    checkedAtUnixMs: Date.now(),
    ...fields,
  };
}

export const PRESETS: FirewallPreset[] = [
  {
    id: 'ssh',
    name: 'SSH',
    description: 'Port 22',
    rules: [{ action: 'allow', protocol: 'tcp', port: 22 }],
    suggestSource: false,
  },
  {
    id: 'http',
    name: 'HTTP',
    description: 'Port 80',
    rules: [{ action: 'allow', protocol: 'tcp', port: 80 }],
    suggestSource: false,
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Port 5432, best kept to your own network',
    rules: [{ action: 'allow', protocol: 'tcp', port: 5432 }],
    suggestSource: true,
  },
];

export function changeSet(fields: Partial<FirewallChangeSetInfo> = {}): FirewallChangeSetInfo {
  return {
    id: CHANGE_ID,
    state: 'awaitingConfirmation',
    backend: 'ufw',
    summary: 'add allow 8080/tcp',
    commands: ['ufw allow 8080/tcp'],
    createdAtUnixMs: Date.now(),
    guardOverridden: false,
    deadlineUnixMs: Date.now() + 60_000,
    requestedBy: 'maria',
    appliedFrom: '203.0.113.50',
    ...fields,
  };
}

export function preview(fields: Partial<FirewallChangePreview> = {}): FirewallChangePreview {
  return {
    summary: 'add allow 8080/tcp',
    commands: ['ufw allow 8080/tcp'],
    notes: [],
    resultingRules: RULES,
    resultingActive: true,
    resultingDefaultIncoming: 'deny',
    guard: { blocked: false, reasons: [], checked: ['SSH on port 22'] },
    needsStepUp: false,
    confirmWithinSeconds: 60,
    ...fields,
  };
}

export const BLOCKED = preview({
  guard: {
    blocked: true,
    reasons: ['Nothing would let new connections reach SSH on port 22.'],
    checked: ['SSH on port 22'],
    confirmationPhrase: 'block ssh on port 22',
  },
  needsStepUp: true,
});

export const EXPOSURE: ExposureInventory = {
  sockets: [
    {
      protocol: 'tcp',
      address: '0.0.0.0',
      port: 22,
      scope: 'public',
      firewall: 'open',
      process: 'sshd',
    },
    {
      protocol: 'tcp',
      address: '127.0.0.1',
      port: 5432,
      scope: 'local',
      firewall: 'notApplicable',
      process: 'postgres',
    },
  ],
  containers: [
    {
      containerId: '3f1c0a9e7b2d',
      containerName: 'shop-db-1',
      image: 'postgres:17',
      protocol: 'tcp',
      hostAddress: '0.0.0.0',
      hostPort: 15432,
      containerPort: 5432,
      scope: 'public',
      firewall: 'bypassed',
    },
  ],
  dockerAvailable: true,
  collectedAtUnixMs: Date.now(),
};
