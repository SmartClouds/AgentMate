import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ipcError, TURNSTILE_SECRET, WIDGET, ZONE } from '../testing/fixtures';
import { TestKeysHint } from './TestKeysHint';
import { TurnstileSnippets } from './TurnstileSnippets';
import { TurnstileSecret } from './widgetParts';

/**
 * The small pieces of the Turnstile tab: a widget's secret, read from Cloudflare only when asked
 * and masked until shown; the code to paste; and Cloudflare's test keys for local work.
 */

describe('TurnstileSecret', () => {
  it('reads the secret only when asked, masked until shown', async () => {
    const secret = vi.fn(async () => TURNSTILE_SECRET);
    const { user } = renderWithProviders(<TurnstileSecret zone={ZONE} sitekey={WIDGET.sitekey} />, {
      bridge: { 'cloudflare.turnstileSecret': secret },
    });
    expect(secret).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Get secret' }));

    expect(secret).toHaveBeenCalledWith(ZONE.id, WIDGET.sitekey);
    expect(await screen.findByRole('button', { name: 'Show secret' })).toBeTruthy();
    expect(screen.queryByText(TURNSTILE_SECRET)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show secret' }));
    expect(screen.getByText(TURNSTILE_SECRET)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy secret' }));
    expect(await navigator.clipboard.readText()).toBe(TURNSTILE_SECRET);
  });

  it('says what went wrong and tries again', async () => {
    const secret = vi
      .fn()
      .mockRejectedValueOnce(ipcError('turnstileSecret', 'Cloudflare took too long to answer.'))
      .mockResolvedValueOnce(TURNSTILE_SECRET);
    const { user } = renderWithProviders(
      <TurnstileSecret zone={ZONE} sitekey={WIDGET.sitekey} autoFetch />,
      { bridge: { 'cloudflare.turnstileSecret': secret } },
    );

    expect(await screen.findByText('Cloudflare took too long to answer.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Show secret' })).toBeTruthy();
  });
});

describe('TurnstileSnippets', () => {
  it('shows the page code with the site key, and the server checks', async () => {
    const { user } = renderWithProviders(<TurnstileSnippets siteKey={WIDGET.sitekey} />);
    const snippet = () => screen.getByTestId('snippet').textContent ?? '';

    expect(snippet()).toContain(`data-sitekey="${WIDGET.sitekey}"`);
    expect(screen.getByText(/check the token on your server/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Node.js check' }));
    expect(snippet()).toContain('process.env.TURNSTILE_SECRET');
    expect(screen.getByText(/reads the secret from TURNSTILE_SECRET/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(await navigator.clipboard.readText()).toBe(snippet());
  });
});

describe('TestKeysHint', () => {
  it('opens on the test keys, each one ready to copy', async () => {
    const { user } = renderWithProviders(<TestKeysHint />);
    expect(screen.queryByText('1x00000000000000000000AA')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Testing on localhost/ }));

    expect(screen.getByText('1x00000000000000000000AA')).toBeTruthy();
    expect(screen.getByText('2x0000000000000000000000000000000AA')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy 1x00000000000000000000AA' }));
    expect(await navigator.clipboard.readText()).toBe('1x00000000000000000000AA');
  });
});
