import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ErrorIssueRow, ErrorIssueRowSkeleton } from './ErrorIssueRow';
import { issue, NOW } from './testing/fixtures';

function renderRow(overrides: Parameters<typeof issue>[0] = {}) {
  const handlers = { onOpen: vi.fn(), onFix: vi.fn(), onCopy: vi.fn() };
  const view = renderWithProviders(
    <ul aria-label="Issues">
      <ErrorIssueRow issue={issue(overrides)} now={NOW} {...handlers} />
    </ul>,
  );
  return { ...view, ...handlers, row: screen.getByRole('listitem') };
}

describe('ErrorIssueRow', () => {
  it('shows what broke, where, how often and when', () => {
    const { row } = renderRow();
    expect(
      within(row).getByRole('button', {
        name: "TypeError: Cannot read properties of undefined (reading 'total')",
      }),
    ).toBeInTheDocument();
    expect(row).toHaveTextContent('checkout/summary.ts in computeTotal');
    expect(row).toHaveTextContent('WEB-3F');
    expect(row).toHaveTextContent('1.2k');
    expect(row).toHaveTextContent('87');
    expect(row).toHaveTextContent('2 min ago');
    expect(row).toHaveTextContent('Error');
    expect(within(row).queryByText('New')).toBeNull();
  });

  it('marks an issue first seen inside the period as new', () => {
    const { row } = renderRow({ isNew: true });
    expect(within(row).getByText('New')).toBeInTheDocument();
  });

  it('draws the trend as 24 bars', () => {
    const { row } = renderRow({ trend: [1, 2, 3] });
    expect(within(row).getAllByTestId('trend-bar')).toHaveLength(24);
  });

  it('opens the issue from its title', async () => {
    const { user, row, onOpen } = renderRow();
    await user.click(within(row).getByRole('button', { name: /TypeError/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: '4501' }));
  });

  it('offers Fix with AI, Copy for AI and the Sentry page', async () => {
    const { user, row, onFix, onCopy } = renderRow();
    await user.click(within(row).getByRole('button', { name: 'Fix with AI' }));
    expect(onFix).toHaveBeenCalledWith(expect.objectContaining({ id: '4501' }));
    await user.click(within(row).getByRole('button', { name: 'Copy for AI' }));
    expect(onCopy).toHaveBeenCalledWith(expect.objectContaining({ id: '4501' }));
    expect(within(row).getByRole('link', { name: 'Open in Sentry' })).toHaveAttribute(
      'href',
      'https://acme.sentry.io/issues/4501/',
    );
  });

  it('hints the row actions with a styled tooltip, never a native title', async () => {
    const { user, row } = renderRow();
    await user.hover(within(row).getByRole('button', { name: 'Copy for AI' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/prompt/i);
    expect(row.querySelector('[title]')).toBeNull();
  });

  it('has a shimmer shape for the first load', () => {
    renderWithProviders(<ErrorIssueRowSkeleton />);
    expect(screen.getByTestId('issue-row-skeleton')).toBeInTheDocument();
  });
});
