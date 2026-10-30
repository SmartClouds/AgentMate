import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ACCOUNT, ipcError } from './testing/fixtures';
import { UsageCard } from './UsageCard';

/**
 * This month's checks against Google's free 10,000, with a warning as the project nears the limit
 * and a plain word about what happens past it.
 */

const PROJECT = { accountId: ACCOUNT.id, projectId: 'shop-project' };

function renderUsage(assessments: number | Error) {
  return renderWithProviders(<UsageCard project={PROJECT} />, {
    bridge: {
      'deployRecaptcha.usage': async () => {
        if (assessments instanceof Error) throw assessments;
        return { month: '2026-10', assessments };
      },
    },
  });
}

describe('UsageCard', () => {
  it('shows this month checks against the free allowance', async () => {
    renderUsage(1240);
    expect(await screen.findByText('1,240')).toBeTruthy();
    expect(screen.getByText(/of 10,000 free checks this month/)).toBeTruthy();
    const meter = screen.getByRole('meter', { name: 'Checks this month' });
    expect(meter).toHaveAttribute('aria-valuenow', '1240');
    expect(meter).toHaveAttribute('aria-valuemax', '10000');
    expect(meter.dataset.tone).toBe('primary');
    expect(screen.getByText(/shared by every project in your Google organization/)).toBeTruthy();
  });

  it('warns when the project is close to the limit', async () => {
    renderUsage(8500);
    expect(await screen.findByText(/Close to the free limit/)).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Checks this month' }).dataset.tone).toBe('warning');
  });

  it('says what happens past the limit', async () => {
    renderUsage(12_000);
    expect(await screen.findByText(/Past the free limit/)).toBeTruthy();
    const meter = screen.getByRole('meter', { name: 'Checks this month' });
    expect(meter.dataset.tone).toBe('destructive');
    expect(meter).toHaveAttribute('aria-valuenow', '10000');
  });

  it('stays quiet when the numbers cannot be read', async () => {
    renderUsage(ipcError('usage', 'Could not reach Google.'));
    expect(await screen.findByText(/Usage is not available right now/)).toBeTruthy();
  });
});
