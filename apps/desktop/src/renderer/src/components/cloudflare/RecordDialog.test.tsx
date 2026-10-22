import type { CloudflareDnsRecord } from '@shared/cloudflareTypes';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { A_RECORD, ipcError, ZONE } from './testing/fixtures';

/**
 * The record editor: one form whose fields follow the type, names typed relative to the zone,
 * and every check the main process makes shown here first, in words.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { RecordDialog } = await import('./RecordDialog');

function renderDialog(bridge: Record<string, unknown>, record?: CloudflareDnsRecord) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <RecordDialog zone={ZONE} record={record} open onOpenChange={onOpenChange} />,
    { bridge },
  );
  return { ...view, onOpenChange };
}

describe('RecordDialog', () => {
  it('adds a proxied A record from a name inside the zone', async () => {
    const { user, bridge, onOpenChange } = renderDialog({
      'cloudflare.createRecord': async () => A_RECORD,
    });

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'app');
    expect(screen.getByText('app.example.com')).toBeInTheDocument();
    await user.type(screen.getByLabelText('IPv4 address'), '203.0.113.10');
    expect(screen.getByLabelText('TTL')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save record' }));

    expect(bridge.$fn('cloudflare.createRecord')).toHaveBeenCalledWith(ZONE.id, {
      type: 'A',
      name: 'app.example.com',
      content: '203.0.113.10',
      ttl: 1,
      proxied: true,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith('Saved the A record for app.example.com.');
  });

  it('shows the fields each type needs', async () => {
    const { user, bridge } = renderDialog({ 'cloudflare.createRecord': async () => A_RECORD });
    const type = screen.getByRole('combobox', { name: 'Type' });
    const pickType = async (name: string) => {
      await user.click(type);
      await user.click(await screen.findByRole('option', { name }));
    };

    await pickType('MX');
    await user.type(screen.getByLabelText('Mail server'), 'mail.example.com');
    expect(screen.getByLabelText('Priority')).toHaveValue(10);
    expect(screen.queryByRole('switch')).toBeNull();
    await user.click(screen.getByRole('combobox', { name: 'TTL' }));
    await user.click(await screen.findByRole('option', { name: '1 hr' }));
    await user.type(screen.getByLabelText('Comment'), 'Mail');
    await user.click(screen.getByRole('button', { name: 'Save record' }));
    expect(bridge.$fn('cloudflare.createRecord')).toHaveBeenLastCalledWith(ZONE.id, {
      type: 'MX',
      name: 'example.com',
      content: 'mail.example.com',
      priority: 10,
      ttl: 3600,
      comment: 'Mail',
    });

    await pickType('CAA');
    expect(screen.getByLabelText('Tag')).toHaveTextContent('issue');
    await user.type(screen.getByLabelText('Value'), 'letsencrypt.org');
    await user.click(screen.getByRole('button', { name: 'Save record' }));
    expect(bridge.$fn('cloudflare.createRecord')).toHaveBeenLastCalledWith(
      ZONE.id,
      expect.objectContaining({
        type: 'CAA',
        caa: { flags: 0, tag: 'issue', value: 'letsencrypt.org' },
      }),
    );

    await pickType('SRV');
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), '_sip._tcp');
    await user.type(screen.getByLabelText('Port'), '5060');
    await user.type(screen.getByLabelText('Target'), 'sip.example.com');
    await user.click(screen.getByRole('button', { name: 'Save record' }));
    expect(bridge.$fn('cloudflare.createRecord')).toHaveBeenLastCalledWith(
      ZONE.id,
      expect.objectContaining({
        type: 'SRV',
        name: '_sip._tcp.example.com',
        srv: { priority: 10, weight: 5, port: 5060, target: 'sip.example.com' },
      }),
    );

    await pickType('TXT');
    await user.type(screen.getByLabelText('Content'), 'v=spf1 -all');
    await user.click(screen.getByRole('button', { name: 'Save record' }));
    expect(bridge.$fn('cloudflare.createRecord')).toHaveBeenLastCalledWith(
      ZONE.id,
      expect.objectContaining({ type: 'TXT', content: 'v=spf1 -all' }),
    );
  });

  it('turns the proxy off for a DNS-only record, which can then have its own TTL', async () => {
    const { user, bridge } = renderDialog({ 'cloudflare.createRecord': async () => A_RECORD });

    await user.click(screen.getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: 'CNAME' }));
    await user.type(screen.getByLabelText('Target'), 'example.net');
    await user.click(screen.getByRole('switch', { name: 'Proxy through Cloudflare' }));
    await user.click(screen.getByRole('combobox', { name: 'TTL' }));
    await user.click(await screen.findByRole('option', { name: '5 min' }));
    await user.click(screen.getByRole('button', { name: 'Save record' }));

    expect(bridge.$fn('cloudflare.createRecord')).toHaveBeenCalledWith(ZONE.id, {
      type: 'CNAME',
      name: 'example.com',
      content: 'example.net',
      ttl: 300,
      proxied: false,
    });
  });

  it('says what is wrong before anything is sent', async () => {
    const { user, bridge } = renderDialog({ 'cloudflare.createRecord': async () => A_RECORD });

    await user.type(screen.getByLabelText('IPv4 address'), '2001:db8::1');
    await user.click(screen.getByRole('button', { name: 'Save record' }));

    expect(screen.getByRole('alert')).toHaveTextContent('An A record needs an IPv4 address');
    expect(() => bridge.$fn('cloudflare.createRecord')).toThrow();
  });

  it('edits an existing record, keeping its type', async () => {
    const { user, bridge } = renderDialog(
      { 'cloudflare.updateRecord': async () => A_RECORD },
      { ...A_RECORD, name: 'www.example.com', comment: 'Site' },
    );

    expect(screen.getByLabelText('Type')).toBeDisabled();
    expect(screen.getByLabelText('Name')).toHaveValue('www');
    expect(screen.getByLabelText('Comment')).toHaveValue('Site');
    await user.clear(screen.getByLabelText('IPv4 address'));
    await user.type(screen.getByLabelText('IPv4 address'), '203.0.113.20');
    await user.click(screen.getByRole('button', { name: 'Save record' }));

    expect(bridge.$fn('cloudflare.updateRecord')).toHaveBeenCalledWith(ZONE.id, A_RECORD.id, {
      type: 'A',
      name: 'www.example.com',
      content: '203.0.113.20',
      ttl: 1,
      proxied: true,
      comment: 'Site',
    });
  });

  it('opens the details of MX, CAA and SRV records for editing', () => {
    const { unmount } = renderDialog(
      {},
      {
        ...A_RECORD,
        type: 'SRV',
        name: '_sip._tcp.example.com',
        content: '5 5060 sip.example.com',
        srv: { priority: 1, weight: 5, port: 5060, target: 'sip.example.com' },
      },
    );
    expect(screen.getByLabelText('Port')).toHaveValue(5060);
    unmount();
    renderDialog(
      {},
      {
        ...A_RECORD,
        type: 'CAA',
        content: '0 issuewild "x.org"',
        caa: { flags: 0, tag: 'issuewild', value: 'x.org' },
      },
    );
    expect(screen.getByLabelText('Tag')).toHaveTextContent('issuewild');
  });

  it("shows Cloudflare's answer when it refuses the record", async () => {
    const { user } = renderDialog({
      'cloudflare.createRecord': async () => {
        throw ipcError(
          'createRecord',
          'Cloudflare said: An A, AAAA, or CNAME record with that host already exists. (code 81053)',
        );
      },
    });

    await user.type(screen.getByLabelText('IPv4 address'), '203.0.113.10');
    await user.click(screen.getByRole('button', { name: 'Save record' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already exists. (code 81053)');
  });
});
