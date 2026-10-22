import type { CloudflareAccessRule } from '@shared/cloudflareTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ipcError, ZONE } from './testing/fixtures';

/** IP access rules (T4): block, challenge or allow an address, a range, a country or a network. */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { AccessRulesCard } = await import('./AccessRulesCard');

const RULE: CloudflareAccessRule = {
  id: '92f17202ed8bd63d69a66b86a49a8f6b',
  mode: 'block',
  target: 'ip',
  value: '198.51.100.4',
  notes: 'Scraper',
  createdOn: '2014-01-01T05:20:00.12345Z',
};

function renderCard(bridge: Record<string, unknown>) {
  return renderWithProviders(
    <>
      <AccessRulesCard zone={ZONE} />
      <ConfirmDialogHost />
    </>,
    { bridge },
  );
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('AccessRulesCard', () => {
  it('shimmers while the rules load', () => {
    const { container } = renderCard({
      'cloudflare.listAccessRules': () => new Promise(() => undefined),
    });
    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('says there are none yet, or what went wrong', async () => {
    const { unmount } = renderCard({ 'cloudflare.listAccessRules': async () => [] });
    expect(await screen.findByText(/No IP access rules yet/)).toBeInTheDocument();
    unmount();
    renderCard({
      'cloudflare.listAccessRules': async () => {
        throw ipcError('listAccessRules', 'This token is not allowed to change IP access rules.');
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('IP access rules');
  });

  it('lists rules in words', async () => {
    renderCard({ 'cloudflare.listAccessRules': async () => [RULE] });
    const item = await screen.findByRole('listitem');
    expect(within(item).getByText('Block')).toBeInTheDocument();
    expect(within(item).getByText('IP address')).toBeInTheDocument();
    expect(within(item).getByText('198.51.100.4')).toBeInTheDocument();
    expect(within(item).getByText('Scraper')).toBeInTheDocument();
  });

  it('adds a rule, saying what the value was read as', async () => {
    const { user, bridge } = renderCard({
      'cloudflare.listAccessRules': async () => [],
      'cloudflare.createAccessRule': async () => ({
        ...RULE,
        mode: 'whitelist',
        target: 'ip_range',
        value: '203.0.113.0/24',
      }),
    });

    await user.type(
      await screen.findByLabelText('Address, range, country or network'),
      '203.0.113.0/24',
    );
    expect(screen.getByText('Read as: IP range')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Action' }));
    await user.click(await screen.findByRole('option', { name: 'Allow' }));
    await user.type(screen.getByLabelText('Notes'), 'Office');
    await user.click(screen.getByRole('button', { name: 'Add access rule' }));

    expect(bridge.$fn('cloudflare.createAccessRule')).toHaveBeenCalledWith(ZONE.id, {
      mode: 'whitelist',
      value: '203.0.113.0/24',
      notes: 'Office',
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Added an Allow rule for 203.0.113.0/24.'),
    );
    expect(screen.getByLabelText('Address, range, country or network')).toHaveValue('');
  });

  it('says what is wrong with a value before sending it', async () => {
    const { user } = renderCard({ 'cloudflare.listAccessRules': async () => [] });
    await user.type(
      await screen.findByLabelText('Address, range, country or network'),
      '203.0.0.0/8',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('/16 or /24');
    expect(screen.getByRole('button', { name: 'Add access rule' })).toBeDisabled();
  });

  it('passes on a refused rule', async () => {
    const { user } = renderCard({
      'cloudflare.listAccessRules': async () => [],
      'cloudflare.createAccessRule': async () => {
        throw ipcError(
          'createAccessRule',
          'Cloudflare said: firewallaccessrules.api.duplicate_of_existing (code 10009)',
        );
      },
    });
    await user.type(await screen.findByLabelText('Address, range, country or network'), 'CN');
    await user.click(screen.getByRole('button', { name: 'Add access rule' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('code 10009')),
    );
  });

  it('deletes a rule only after asking', async () => {
    const { user, bridge } = renderCard({
      'cloudflare.listAccessRules': async () => [RULE],
      'cloudflare.deleteAccessRule': async () => undefined,
    });

    await user.click(
      await screen.findByRole('button', { name: 'Delete the rule for 198.51.100.4' }),
    );
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete rule' }),
    );

    expect(bridge.$fn('cloudflare.deleteAccessRule')).toHaveBeenCalledWith(ZONE.id, RULE.id);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Deleted the rule for 198.51.100.4.'),
    );
  });
});
