import { validateIpOrCidr } from '@runova/core';
import type {
  FirewallChange,
  FirewallRuleInfo,
  FirewallStatus,
} from './protocol/generated/Runova.ServerCore.Contracts';

/**
 * Checks for the direct TLS form (as the user types) and its IPC handler, and the firewall change
 * set that opens or closes the port. The core checks the port and sources again.
 */

export type DirectTlsCheck<T> = { ok: true; value: T } | { ok: false; reason: string };

export const MAX_SOURCES = 16;

/** The comment the rule carries on ufw (firewalld keeps no comments), so it can be found again. */
export const DIRECT_TLS_RULE_COMMENT = 'Runova direct TLS';

export function checkDirectTlsPort(input: string | number): DirectTlsCheck<number> {
  const text = String(input).trim();
  if (!/^\d{1,5}$/.test(text)) return { ok: false, reason: 'The port is a number, such as 7443.' };
  const port = Number(text);
  if (port < 1024 || port > 65535) {
    return { ok: false, reason: 'Pick a port from 1024 to 65535.' };
  }
  return { ok: true, value: port };
}

/**
 * Addresses or networks, one per line or separated by commas or spaces, in their canonical form
 * and without repeats. Empty means every address.
 */
export function checkSources(input: string | readonly string[]): DirectTlsCheck<string[]> {
  const items = (typeof input === 'string' ? input.split(/[\s,]+/) : [...input])
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length > MAX_SOURCES) {
    return { ok: false, reason: `At most ${MAX_SOURCES} addresses or networks.` };
  }
  const sources: string[] = [];
  for (const item of items) {
    const network = validateIpOrCidr(item);
    if (!network.ok) return { ok: false, reason: network.reason };
    if (network.value.prefix === 0) {
      return { ok: false, reason: 'Leave the sources empty to allow every address.' };
    }
    const canonical =
      network.value.prefix === (network.value.version === 4 ? 32 : 128)
        ? network.value.network
        : network.value.value;
    if (!sources.includes(canonical)) sources.push(canonical);
  }
  return { ok: true, value: sources };
}

/** A rule this mode made (or one just like it): allow TCP to exactly this port. */
function isPortRule(rule: FirewallRuleInfo, port: number): boolean {
  return (
    rule.editable &&
    !rule.outgoing &&
    rule.action === 'allow' &&
    rule.protocol === 'tcp' &&
    rule.port === port &&
    rule.portTo === undefined &&
    (rule.comment === undefined || rule.comment === DIRECT_TLS_RULE_COMMENT)
  );
}

/**
 * The change set that lets exactly `sources` (everyone when empty) reach the port: rules for
 * sources no longer wanted go, missing ones are added. Nothing when the firewall is not installed
 * or the rules are already right.
 */
export function openPortChanges(
  status: FirewallStatus,
  port: number,
  sources: readonly string[],
): FirewallChange[] {
  if (!status.installed || status.backend === 'none') return [];
  const wanted: (string | undefined)[] = sources.length > 0 ? [...sources] : [undefined];
  const existing = status.rules.filter((rule) => isPortRule(rule, port));
  const removals = existing
    .filter((rule) => !wanted.includes(rule.source))
    .map((rule): FirewallChange => ({ kind: 'removeRule', ruleId: rule.id }));
  const additions = wanted
    .filter((source) => !existing.some((rule) => rule.source === source))
    .map(
      (source): FirewallChange => ({
        kind: 'addRule',
        rule: {
          action: 'allow',
          protocol: 'tcp',
          port,
          ...(source ? { source } : {}),
          comment: DIRECT_TLS_RULE_COMMENT,
        },
      }),
    );
  return [...removals, ...additions];
}

/**
 * The change set that closes the port again. A rule with this mode's comment always goes; on
 * firewalld, which keeps no comments, a rule goes when it matches one of the sources the mode used.
 */
export function closePortChanges(
  status: FirewallStatus,
  port: number,
  sources: readonly string[],
): FirewallChange[] {
  if (!status.installed || status.backend === 'none') return [];
  const used: (string | undefined)[] = sources.length > 0 ? [...sources] : [undefined];
  return status.rules
    .filter(
      (rule) =>
        isPortRule(rule, port) &&
        (rule.comment === DIRECT_TLS_RULE_COMMENT || used.includes(rule.source)),
    )
    .map((rule): FirewallChange => ({ kind: 'removeRule', ruleId: rule.id }));
}
