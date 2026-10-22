import { describe, expect, it } from 'vitest';
import { missingRules, offerFirewallRules, takeFirewallRules } from './restoredRules';

/** A restore hands its firewall rules to the Firewall section once, and only the new ones stage. */

describe('restored firewall rules', () => {
  it('are taken once', () => {
    offerFirewallRules('srv-1', [{ action: 'allow', protocol: 'tcp', port: 443 }]);
    expect(takeFirewallRules('srv-1')).toHaveLength(1);
    expect(takeFirewallRules('srv-1')).toEqual([]);
  });

  it('leave out what the firewall already has', () => {
    expect(
      missingRules(
        [
          { action: 'allow', protocol: 'tcp', port: 443 },
          { action: 'allow', protocol: 'tcp', port: 22, source: '10.0.0.0/8' },
        ],
        [{ action: 'allow', protocol: 'tcp', port: 443 }],
      ),
    ).toEqual([{ action: 'allow', protocol: 'tcp', port: 22, source: '10.0.0.0/8' }]);
  });
});
