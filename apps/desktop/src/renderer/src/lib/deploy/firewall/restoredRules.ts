import type { FirewallRuleSpec } from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';

/**
 * Firewall rules a restored backup brought (E28), waiting for the Firewall section to stage them.
 * The restore never applies them itself: they go through the usual review, safe apply and keep,
 * like any other firewall change.
 */

const waiting = new Map<string, FirewallRuleSpec[]>();

export function offerFirewallRules(serverId: string, rules: FirewallRuleSpec[]): void {
  waiting.set(serverId, rules);
}

/** The rules offered for a server, once; the next call has none. */
export function takeFirewallRules(serverId: string): FirewallRuleSpec[] {
  const rules = waiting.get(serverId) ?? [];
  waiting.delete(serverId);
  return rules;
}

/** The rules the firewall does not have yet, the same way the checklist's fix compares them. */
export function missingRules(
  wanted: FirewallRuleSpec[],
  existing: readonly Pick<FirewallRuleSpec, 'action' | 'protocol' | 'port' | 'portTo' | 'source'>[],
): FirewallRuleSpec[] {
  return wanted.filter(
    (rule) =>
      !existing.some(
        (have) =>
          have.action === rule.action &&
          have.protocol === rule.protocol &&
          (have.port ?? null) === (rule.port ?? null) &&
          (have.portTo ?? null) === (rule.portTo ?? null) &&
          (have.source ?? null) === (rule.source ?? null),
      ),
  );
}
