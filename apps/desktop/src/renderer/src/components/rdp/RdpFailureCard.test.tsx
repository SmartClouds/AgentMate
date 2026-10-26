import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { describeProxyFailure } from '@/lib/rdp/failure';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { failureReport, RdpFailureBody, RdpFailureCard } from './RdpFailureCard';

/**
 * A connection that fails used to put the TLS library's raw error, source path and line number
 * on the screen. The card shows a heading, a sentence and things to try; the technical reason is
 * folded away and cleaned of source locations.
 */

const LIBRARY_TEXT = /error:|OPENSSL_internal|boringssl|ssl_cert\.cc|third_party/i;

const keyUsage = describeProxyFailure({
  code: 'tls-key-usage',
  message:
    "The certificate 176.9.22.106:3389 presented can't be used to set up an encrypted connection.",
  detail: 'KEY_USAGE_BIT_INCORRECT (SSL routines)',
});

function renderCard(failure = keyUsage) {
  const handlers = { onClose: vi.fn(), onReconnect: vi.fn(), onReviewCertificate: vi.fn() };
  const view = renderWithProviders(<RdpFailureCard failure={failure} {...handlers} />);
  return { ...view, ...handlers };
}

describe('RdpFailureCard', () => {
  it('shows what happened and what to try, in plain words', () => {
    renderCard();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("The server's certificate can't be used");
    expect(alert).toHaveTextContent(
      "The certificate 176.9.22.106:3389 presented can't be used to set up an encrypted connection.",
    );
    expect(screen.getByText('What you can try')).toBeInTheDocument();
    expect(
      screen.getByText(/Windows made this certificate for Remote Desktop/),
    ).toBeInTheDocument();
  });

  it('never shows library text or source locations', () => {
    renderCard();
    expect(document.body.textContent).not.toMatch(LIBRARY_TEXT);
  });

  it('folds the technical details away until asked', async () => {
    const { user } = renderCard();

    const summary = screen.getByText('Technical details');
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open');

    await user.click(summary);

    expect(details).toHaveAttribute('open');
    expect(screen.getByText('KEY_USAGE_BIT_INCORRECT (SSL routines)')).toBeInTheDocument();
  });

  it('copies a report with the heading, the sentence and the technical reason', async () => {
    const { user } = renderCard();

    await user.click(screen.getByText('Technical details'));
    await user.click(screen.getByRole('button', { name: 'Copy technical details' }));

    expect(await navigator.clipboard.readText()).toBe(failureReport(keyUsage));
    expect(failureReport(keyUsage)).toBe(
      [
        "The server's certificate can't be used",
        "The certificate 176.9.22.106:3389 presented can't be used to set up an encrypted connection.",
        'Technical details: KEY_USAGE_BIT_INCORRECT (SSL routines)',
      ].join('\n'),
    );
  });

  it('leaves out the technical details when there are none', () => {
    renderCard(
      describeProxyFailure({ code: 'refused', message: 'x:3389 refused the connection.' }),
    );
    expect(screen.queryByText('Technical details')).not.toBeInTheDocument();
  });

  it('offers to close and to reconnect', async () => {
    const { user, onClose, onReconnect, onReviewCertificate } = renderCard();

    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Review certificate' })).not.toBeInTheDocument();
    expect(onReviewCertificate).not.toHaveBeenCalled();
  });

  it('leads with reviewing the certificate when it changed, since reconnecting would only fail again', async () => {
    const { user, onReviewCertificate } = renderCard(
      describeProxyFailure({
        code: 'certificate-changed',
        message: '176.9.22.106 is presenting a different certificate than the one Runova saved.',
      }),
    );

    const buttons = screen.getAllByRole('button').map((button) => button.textContent?.trim());
    expect(buttons).toEqual(['Close', 'Review certificate', 'Reconnect']);

    await user.click(screen.getByRole('button', { name: 'Review certificate' }));
    expect(onReviewCertificate).toHaveBeenCalledOnce();
  });
});

describe('RdpFailureBody', () => {
  it('holds the words of a failure without the actions of the card', () => {
    renderWithProviders(<RdpFailureBody failure={keyUsage} align="start" />);

    expect(screen.getByText("The server's certificate can't be used")).toBeInTheDocument();
    expect(screen.getByText('What you can try')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });
});
