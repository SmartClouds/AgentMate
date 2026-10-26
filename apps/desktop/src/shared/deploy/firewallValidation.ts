import { validateIpOrCidr, validatePort, validatePortRange } from '@runova/core';
import type {
  FirewallAction,
  FirewallChange,
  FirewallPolicy,
  FirewallProtocol,
  FirewallRuleSpec,
} from './protocol/generated/Runova.ServerCore.Contracts';

/**
 * Checks for firewall rules, shared by the rule form (as the user types) and the IPC handlers
 * (before the core hears of it). Ports and sources go through the Deploy validators in
 * `@runova/core`, so a source is a canonical address or network. The core checks again.
 */

export type RuleCheck<T> = { ok: true; value: T } | { ok: false; reason: string };

export const FIREWALL_ACTIONS: readonly FirewallAction[] = ['allow', 'deny', 'reject', 'limit'];
export const FIREWALL_PROTOCOLS: readonly FirewallProtocol[] = ['tcp', 'udp', 'any'];
export const FIREWALL_POLICIES: readonly FirewallPolicy[] = ['allow', 'deny', 'reject'];
/** ufw and firewalld both keep comments short; 64 is what fits a table cell too. */
export const COMMENT_MAX = 64;
/** More than this in one change set is a script, not a person at a form. */
export const MAX_CHANGES = 50;
const RULE_ID_MAX = 128;

const refuse = <T>(reason: string): RuleCheck<T> => ({ ok: false, reason });

/** What the rule form holds: text as typed. */
export interface RuleDraft {
  action: FirewallAction;
  protocol: FirewallProtocol;
  /** A port, a range such as 6000-6007, or empty for every port. */
  ports: string;
  /** An address or a CIDR network, or empty for anywhere. */
  source: string;
  comment: string;
}

export function checkComment(input: string): RuleCheck<string | undefined> {
  const comment = input.trim();
  if (comment.length === 0) return { ok: true, value: undefined };
  if (comment.length > COMMENT_MAX)
    return refuse(`Keep the comment under ${COMMENT_MAX + 1} characters.`);
  // A quote or a control character would end the comment early in ufw's own command line.
  if (/[\p{Cc}'"`\\]/u.test(comment))
    return refuse('Leave quotes, backslashes and line breaks out of the comment.');
  return { ok: true, value: comment };
}

/** The rule a draft describes, in the form the core takes. */
export function ruleFromDraft(draft: RuleDraft): RuleCheck<FirewallRuleSpec> {
  const spec: FirewallRuleSpec = { action: draft.action, protocol: draft.protocol };
  const ports = draft.ports.trim();
  if (ports.length > 0) {
    if (draft.protocol === 'any') return refuse('Pick TCP or UDP to open a port.');
    const range = validatePortRange(ports);
    if (!range.ok) return range;
    spec.port = range.value.start;
    if (range.value.end !== range.value.start) spec.portTo = range.value.end;
  }
  const source = draft.source.trim();
  if (source.length > 0) {
    const network = validateIpOrCidr(source);
    if (!network.ok) return network;
    spec.source =
      network.value.prefix === (network.value.version === 4 ? 32 : 128)
        ? network.value.network
        : network.value.value;
  }
  if (spec.port === undefined && spec.source === undefined) {
    return refuse(
      'Give a port or a source. A rule for everything from everywhere is a default policy.',
    );
  }
  const comment = checkComment(draft.comment);
  if (!comment.ok) return comment;
  if (comment.value) spec.comment = comment.value;
  return { ok: true, value: spec };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`That is not a firewall ${what}.`);
  }
  return value as T;
}

function unwrap<T>(check: RuleCheck<T>): T {
  if (!check.ok) throw new Error(check.reason);
  return check.value;
}

/** A rule from across IPC, checked field by field. Throws a reason a person can act on. */
export function parseRuleSpec(value: unknown): FirewallRuleSpec {
  if (typeof value !== 'object' || value === null) throw new Error('Expected a firewall rule.');
  const input = value as Record<string, unknown>;
  const spec: FirewallRuleSpec = {
    action: oneOf(input.action, FIREWALL_ACTIONS, 'action'),
    protocol: oneOf(input.protocol, FIREWALL_PROTOCOLS, 'protocol'),
  };
  if (input.port !== undefined) {
    spec.port = unwrap(validatePort(input.port as number));
    if (input.portTo !== undefined) {
      spec.portTo = unwrap(validatePort(input.portTo as number));
      if (spec.portTo < spec.port)
        throw new Error("The first port of a range can't be higher than the last.");
    }
    if (spec.protocol === 'any') throw new Error('Pick TCP or UDP to open a port.');
  } else if (input.portTo !== undefined) {
    throw new Error('A range needs its first port.');
  }
  if (input.source !== undefined) {
    if (typeof input.source !== 'string') throw new Error('The source must be text.');
    unwrap(validateIpOrCidr(input.source));
    spec.source = input.source;
  }
  if (input.comment !== undefined) {
    if (typeof input.comment !== 'string') throw new Error('The comment must be text.');
    const comment = unwrap(checkComment(input.comment));
    if (comment) spec.comment = comment;
  }
  return spec;
}

/** A change set from across IPC: 1 to MAX_CHANGES changes, each checked. */
export function parseChanges(value: unknown): FirewallChange[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('A change set needs a change.');
  if (value.length > MAX_CHANGES)
    throw new Error(`Apply at most ${MAX_CHANGES} changes at a time.`);
  return value.map((item): FirewallChange => {
    if (typeof item !== 'object' || item === null) throw new Error('Expected a firewall change.');
    const change = item as Record<string, unknown>;
    switch (change.kind) {
      case 'addRule':
        return { kind: 'addRule', rule: parseRuleSpec(change.rule) };
      case 'removeRule':
        if (
          typeof change.ruleId !== 'string' ||
          change.ruleId.length === 0 ||
          change.ruleId.length > RULE_ID_MAX
        ) {
          throw new Error('That is not a firewall rule.');
        }
        return { kind: 'removeRule', ruleId: change.ruleId };
      case 'setDefaultIncoming':
        return {
          kind: 'setDefaultIncoming',
          policy: oneOf(change.policy, FIREWALL_POLICIES, 'policy'),
        };
      case 'enable':
      case 'disable':
        return { kind: change.kind };
      default:
        throw new Error('That is not a firewall change.');
    }
  });
}
