import { describe, expect, it } from 'vitest';
import {
  checkDirectTlsPort,
  checkSources,
  closePortChanges,
  DIRECT_TLS_RULE_COMMENT,
  MAX_SOURCES,
  openPortChanges,
} from './directTlsValidation';
import type {
  FirewallRuleInfo,
  FirewallStatus,
} from './protocol/generated/Runova.ServerCore.Contracts';

function rule(id: string, extra: Partial<FirewallRuleInfo> = {}): FirewallRuleInfo {
  return {
    id,
    action: 'allow',
    protocol: 'tcp',
    families: 'both',
    description: id,
    editable: true,
    outgoing: false,
    port: 7443,
    comment: DIRECT_TLS_RULE_COMMENT,
    ...extra,
  };
}

function status(rules: FirewallRuleInfo[], extra: Partial<FirewallStatus> = {}): FirewallStatus {
  return {
    backend: 'ufw',
    installed: true,
    active: true,
    defaultIncoming: 'deny',
    defaultOutgoing: 'allow',
    ipv6: true,
    rules,
    warnings: [],
    ssh: { ports: [22] },
    confirmWithinSeconds: 60,
    checkedAtUnixMs: 0,
    ...extra,
  };
}

describe('checkDirectTlsPort', () => {
  it('takes a port from 1024 up', () => {
    expect(checkDirectTlsPort('7443')).toEqual({ ok: true, value: 7443 });
    expect(checkDirectTlsPort(65535)).toEqual({ ok: true, value: 65535 });
    expect(checkDirectTlsPort('443').ok).toBe(false);
    expect(checkDirectTlsPort('70000').ok).toBe(false);
    expect(checkDirectTlsPort('74 43').ok).toBe(false);
  });
});

describe('checkSources', () => {
  it('splits, normalizes and drops repeats', () => {
    expect(checkSources('203.0.113.7/32, 10.0.0.0/8\n10.0.0.0/8  2001:db8::/32')).toEqual({
      ok: true,
      value: ['203.0.113.7', '10.0.0.0/8', '2001:db8::/32'],
    });
    expect(checkSources('')).toEqual({ ok: true, value: [] });
  });

  it('refuses what is not an address, a network for everyone, or too many', () => {
    expect(checkSources('example.com').ok).toBe(false);
    expect(checkSources('10.0.0.1/8').ok).toBe(false);
    expect(checkSources('0.0.0.0/0')).toEqual({
      ok: false,
      reason: 'Leave the sources empty to allow every address.',
    });
    const many = Array.from({ length: MAX_SOURCES + 1 }, (_, i) => `192.0.2.${i + 1}`);
    expect(checkSources(many).ok).toBe(false);
  });
});

describe('openPortChanges', () => {
  it('adds one rule for everyone when no source is given', () => {
    expect(openPortChanges(status([]), 7443, [])).toEqual([
      {
        kind: 'addRule',
        rule: { action: 'allow', protocol: 'tcp', port: 7443, comment: DIRECT_TLS_RULE_COMMENT },
      },
    ]);
  });

  it('swaps the rules to the new sources and keeps the ones still wanted', () => {
    const current = status([
      rule('a', { source: '10.0.0.0/8' }),
      rule('b', { source: '203.0.113.7' }),
      rule('other', { port: 22 }),
    ]);

    expect(openPortChanges(current, 7443, ['10.0.0.0/8', '198.51.100.0/24'])).toEqual([
      { kind: 'removeRule', ruleId: 'b' },
      {
        kind: 'addRule',
        rule: {
          action: 'allow',
          protocol: 'tcp',
          port: 7443,
          source: '198.51.100.0/24',
          comment: DIRECT_TLS_RULE_COMMENT,
        },
      },
    ]);
  });

  it('has nothing to do without a firewall or when the rules are right', () => {
    expect(openPortChanges(status([], { backend: 'none', installed: false }), 7443, [])).toEqual(
      [],
    );
    expect(openPortChanges(status([rule('a')]), 7443, [])).toEqual([]);
  });
});

describe('closePortChanges', () => {
  it('removes the rules of the mode and leaves rules for other ports or made by hand', () => {
    const current = status([
      rule('mine'),
      rule('firewalld', { comment: undefined, source: '10.0.0.0/8', id: 'firewalld' }),
      rule('byHand', { comment: 'office', source: '10.0.0.0/8' }),
      rule('otherPort', { port: 8443 }),
      rule('deny', { action: 'deny' }),
    ]);

    expect(closePortChanges(current, 7443, ['10.0.0.0/8'])).toEqual([
      { kind: 'removeRule', ruleId: 'mine' },
      { kind: 'removeRule', ruleId: 'firewalld' },
    ]);
    expect(closePortChanges(status([], { installed: false }), 7443, [])).toEqual([]);
  });
});
