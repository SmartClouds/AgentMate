import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RdpLinkIndicator } from './RdpLinkIndicator';

const stats = { downBytesPerSec: 1.21 * 1024 * 1024, upBytesPerSec: 34 * 1024, latencyMs: 42 };

describe('RdpLinkIndicator', () => {
  it('shows the download and upload speed', () => {
    renderWithProviders(<RdpLinkIndicator stats={stats} />);
    const indicator = screen.getByTestId('rdp-link-indicator');
    expect(indicator).toHaveTextContent('1.21 MB/s');
    expect(indicator).toHaveTextContent('34.0 KB/s');
  });

  it('names the quality for a screen reader', () => {
    renderWithProviders(<RdpLinkIndicator stats={stats} />);
    expect(screen.getByRole('img', { name: 'Connection quality Excellent' })).toBeInTheDocument();
  });

  it('shows zero speed and no verdict before the first reading', () => {
    renderWithProviders(<RdpLinkIndicator stats={null} />);
    expect(screen.getByTestId('rdp-link-indicator')).toHaveTextContent('0 B/s');
    expect(screen.getByRole('img', { name: 'Connection quality unknown' })).toBeInTheDocument();
  });

  it('explains the reading on hover', async () => {
    const { user } = renderWithProviders(<RdpLinkIndicator stats={{ ...stats, latencyMs: 210 }} />);
    await user.hover(screen.getByTestId('rdp-link-indicator'));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Connection quality: Fair');
    expect(tip).toHaveTextContent('about 210 ms');
    expect(tip).toHaveTextContent('Download 1.21 MB/s, upload 34.0 KB/s');
  });

  it('says it is still measuring when no input has been answered yet', async () => {
    const { user } = renderWithProviders(
      <RdpLinkIndicator stats={{ ...stats, latencyMs: null }} />,
    );
    await user.hover(screen.getByTestId('rdp-link-indicator'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Connection quality: measuring');
  });
});
