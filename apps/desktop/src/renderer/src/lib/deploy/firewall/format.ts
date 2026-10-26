import type { RuleDraft } from '@shared/deploy/firewallValidation';
import type {
  ExposureFirewall,
  ExposureScope,
  FirewallAction,
  FirewallBackendKind,
  FirewallChange,
  FirewallChangeSetInfo,
  FirewallPolicy,
  FirewallProtocol,
  FirewallRuleInfo,
  FirewallRuleSpec,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployFirewallStep } from '@shared/deployFirewallTypes';

/** Words for the Firewall section: rules, policies, change sets and exposure. */

export const BACKEND_LABEL: Record<FirewallBackendKind, string> = {
  none: 'No firewall',
  ufw: 'ufw',
  firewalld: 'firewalld',
};

export const ACTION_LABEL: Record<FirewallAction, string> = {
  allow: 'Allow',
  deny: 'Deny',
  reject: 'Reject',
  limit: 'Limit',
};

export const ACTION_HINT: Record<FirewallAction, string> = {
  allow: 'Lets the traffic in.',
  deny: 'Drops it without an answer.',
  reject: 'Turns it away with an answer, so the sender knows at once.',
  limit: 'Lets it in, but blocks an address that connects 6 times in 30 seconds.',
};

export const PROTOCOL_LABEL: Record<FirewallProtocol, string> = {
  tcp: 'TCP',
  udp: 'UDP',
  any: 'Any',
};

export const POLICY_LABEL: Record<FirewallPolicy, string> = {
  allow: 'Allow',
  deny: 'Deny',
  reject: 'Reject',
};

export const SCOPE_LABEL: Record<ExposureScope, string> = {
  public: 'Public',
  private: 'Private network',
  local: 'This machine only',
};

export const EXPOSURE_FIREWALL_LABEL: Record<ExposureFirewall, string> = {
  off: 'Firewall off',
  open: 'Open',
  restricted: 'Some sources',
  closed: 'Blocked',
  bypassed: 'Bypasses the firewall',
  notApplicable: 'Not reachable',
};

export const STEP_LABEL: Record<DeployFirewallStep, string> = {
  readingConnection: 'Reading this connection',
  applying: 'Applying the change',
  openingConnection: 'Opening a new SSH connection',
  signingIn: 'Signing in through it',
  confirming: 'Keeping the change',
  reverting: 'Putting the old rules back',
};

/** "22", "6000-6007", or "Any port". */
export function portsText(rule: Pick<FirewallRuleSpec, 'port' | 'portTo'>): string {
  if (rule.port === undefined) return 'Any port';
  return rule.portTo !== undefined && rule.portTo !== rule.port
    ? `${rule.port}-${rule.portTo}`
    : String(rule.port);
}

export function sourceText(rule: Pick<FirewallRuleInfo, 'source'>): string {
  return rule.source ?? 'Anywhere';
}

/** A one-line description of a rule spec, as it is staged. */
export function describeSpec(rule: FirewallRuleSpec): string {
  const proto = rule.protocol === 'any' ? '' : ` ${PROTOCOL_LABEL[rule.protocol]}`;
  const port = rule.port === undefined ? 'all traffic' : `port ${portsText(rule)}${proto}`;
  const from = rule.source ? ` from ${rule.source}` : '';
  return `${ACTION_LABEL[rule.action]} ${port}${from}`;
}

/** A staged change in words, for the list of what is about to be applied. */
export function describeChange(change: FirewallChange, rules: FirewallRuleInfo[]): string {
  switch (change.kind) {
    case 'addRule':
      return change.rule ? `Add: ${describeSpec(change.rule)}` : 'Add a rule';
    case 'removeRule': {
      const rule = rules.find((candidate) => candidate.id === change.ruleId);
      return rule ? `Remove: ${describeSpec(rule)}` : 'Remove a rule';
    }
    case 'setDefaultIncoming':
      return `Incoming by default: ${POLICY_LABEL[change.policy ?? 'deny']}`;
    case 'enable':
      return 'Turn the firewall on';
    case 'disable':
      return 'Turn the firewall off';
  }
}

export function draftFromRule(rule?: FirewallRuleInfo): RuleDraft {
  return {
    action: rule?.action ?? 'allow',
    protocol: rule?.protocol ?? 'tcp',
    ports: rule ? (rule.port === undefined ? '' : portsText(rule)) : '',
    source: rule?.source ?? '',
    comment: rule?.comment ?? '',
  };
}

/** Whole seconds until a deadline, never below zero. */
export function secondsLeft(deadlineUnixMs: number, now: number): number {
  return Math.max(0, Math.ceil((deadlineUnixMs - now) / 1000));
}

/** "0:42". */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function changeStateText(change: FirewallChangeSetInfo): string {
  switch (change.state) {
    case 'applying':
      return 'Applying';
    case 'awaitingConfirmation':
      return 'Waiting to be kept';
    case 'confirmed':
      return 'Kept';
    case 'rolledBack':
      if (change.rolledBackBy === 'timer') return 'Rolled back: nobody kept it in time';
      if (change.rolledBackBy === 'user') return 'Reverted';
      if (change.rolledBackBy === 'restart') return 'Rolled back when the core restarted';
      return 'Rolled back: it did not apply';
    case 'rollbackFailed':
      return 'Rollback failed';
    case 'failed':
      return 'Failed';
  }
}
