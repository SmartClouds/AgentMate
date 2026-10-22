import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ipcError, ZONE } from './testing/fixtures';

/**
 * The custom rule builder (T4): pick a rule, fill in what it is about, and see the expression
 * Cloudflare will run before adding it.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { RuleBuilderDialog } = await import('./RuleBuilderDialog');

function renderDialog(bridge: Record<string, unknown> = {}) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <RuleBuilderDialog zone={ZONE} open onOpenChange={onOpenChange} />,
    {
      bridge,
    },
  );
  return { ...view, onOpenChange };
}

describe('RuleBuilderDialog', () => {
  it('blocks countries, showing the expression and a description to start from', async () => {
    const rules = [
      {
        id: 'a'.repeat(32),
        description: 'Block CN, RU',
        expression: '',
        action: 'block',
        enabled: true,
        lastUpdated: null,
      },
    ];
    const { user, bridge, onOpenChange, queryClient } = renderDialog({
      'cloudflare.createCustomRule': async () => rules,
    });

    await user.type(screen.getByLabelText('Country codes'), 'cn, ru');

    expect(screen.getByLabelText('Expression')).toHaveTextContent(
      '(ip.src.country in {"CN" "RU"})',
    );
    expect(screen.getByText('Action: Block')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue('Block CN, RU');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    expect(bridge.$fn('cloudflare.createCustomRule')).toHaveBeenCalledWith(ZONE.id, {
      description: 'Block CN, RU',
      spec: { kind: 'block-countries', countries: ['cn', 'ru'] },
    });
    expect(queryClient.getQueryData(queryKeys.cloudflareCustomRules(ZONE.id))).toEqual(rules);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith('Added the rule Block CN, RU.');
  });

  it('challenges a path and everything under it', async () => {
    const { user, bridge } = renderDialog({ 'cloudflare.createCustomRule': async () => [] });

    await user.click(screen.getByRole('radio', { name: 'Challenge a path' }));
    await user.type(screen.getByLabelText('Path'), '/admin');
    await user.click(screen.getByRole('combobox', { name: 'Match' }));
    await user.click(
      await screen.findByRole('option', { name: 'This path and everything under it' }),
    );

    expect(screen.getByLabelText('Expression')).toHaveTextContent(
      '(starts_with(http.request.uri.path, "/admin"))',
    );
    expect(screen.getByText('Action: Managed challenge')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(bridge.$fn('cloudflare.createCustomRule')).toHaveBeenCalledWith(ZONE.id, {
      description: 'Challenge /admin and below',
      spec: { kind: 'challenge-path', path: '/admin', match: 'prefix' },
    });
  });

  it('allows addresses, and says the rule goes first', async () => {
    const { user, bridge } = renderDialog({ 'cloudflare.createCustomRule': async () => [] });

    await user.click(screen.getByRole('radio', { name: 'Allow IP addresses' }));
    await user.type(
      screen.getByLabelText('Addresses and ranges'),
      '203.0.113.10{enter}2001:db8::/32',
    );
    await user.clear(screen.getByLabelText('Description'));
    await user.type(screen.getByLabelText('Description'), 'Office');

    expect(screen.getByLabelText('Expression')).toHaveTextContent(
      '(ip.src in {203.0.113.10 2001:db8::/32})',
    );
    expect(screen.getByText(/goes first/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(bridge.$fn('cloudflare.createCustomRule')).toHaveBeenCalledWith(ZONE.id, {
      description: 'Office',
      spec: { kind: 'allow-ips', ips: ['203.0.113.10', '2001:db8::/32'] },
    });
  });

  it('says what is wrong instead of an expression, and will not add it', async () => {
    const { user } = renderDialog();

    await user.type(screen.getByLabelText('Country codes'), 'USA');

    expect(screen.getByRole('alert')).toHaveTextContent('USA is not a two-letter country code');
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeDisabled();
  });

  it("shows Cloudflare's answer when it refuses the rule", async () => {
    const { user } = renderDialog({
      'cloudflare.createCustomRule': async () => {
        throw ipcError('createCustomRule', 'Cloudflare said: exceeded the rule limit (code 20120)');
      },
    });

    await user.type(screen.getByLabelText('Country codes'), 'CN');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('rule limit');
  });
});
