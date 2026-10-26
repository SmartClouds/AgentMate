import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { HealthTargetCard } from './HealthTargetCard';
import { detail, NOW, target } from './testing/fixtures';

describe('HealthTargetCard', () => {
  it('shows the name, server, host and the state in words', () => {
    renderWithProviders(<HealthTargetCard target={target()} now={NOW} onOpen={vi.fn()} />);
    const card = screen.getByRole('article', { name: 'API' });
    expect(within(card).getByText('web-1')).toBeInTheDocument();
    expect(within(card).getByText('api.example.com')).toBeInTheDocument();
    expect(card).not.toHaveTextContent('probe=1');
    expect(card).not.toHaveTextContent('_runova');
    expect(within(card).getByText('Healthy')).toBeInTheDocument();
  });

  it('shows the latency, the last and the next check, and the uptime', () => {
    renderWithProviders(<HealthTargetCard target={target()} now={NOW} onOpen={vi.fn()} />);
    const card = screen.getByRole('article', { name: 'API' });
    expect(card).toHaveTextContent('120 ms');
    expect(card).toHaveTextContent('30 sec ago');
    expect(card).toHaveTextContent('in 30 sec');
    expect(card).toHaveTextContent('99.50%');
  });

  it('says a paused target has no next check', () => {
    renderWithProviders(
      <HealthTargetCard
        target={target({ paused: true, state: 'paused' })}
        now={NOW}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole('article', { name: 'API' })).toHaveTextContent('Not scheduled');
  });

  it('puts the headline problem on the card', () => {
    renderWithProviders(
      <HealthTargetCard
        target={target({ state: 'fail', headline: 'postgres: Connection refused' })}
        now={NOW}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText('postgres: Connection refused')).toBeInTheDocument();
    expect(screen.getByText('Down')).toBeInTheDocument();
  });

  it('opens the detail panel from the name', async () => {
    const onOpen = vi.fn();
    const { user } = renderWithProviders(
      <HealthTargetCard target={target()} now={NOW} onOpen={onOpen} />,
    );
    await user.click(screen.getByRole('button', { name: 'Open API' }));
    expect(onOpen).toHaveBeenCalledWith('t1');
  });

  it('loads the services only when they are expanded', async () => {
    const get = vi.fn(async () => detail());
    const { user } = renderWithProviders(
      <HealthTargetCard
        target={target({ servicesTotal: 2, servicesFailing: 1 })}
        now={NOW}
        onOpen={vi.fn()}
      />,
      { bridge: { 'health.get': get } },
    );
    const toggle = screen.getByRole('button', { name: /2 services, 1 failing/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(get).not.toHaveBeenCalled();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = await screen.findByRole('list', { name: 'Services' });
    expect(within(list).getByText('postgres:connection')).toBeInTheDocument();
    expect(within(list).getByText('Fail')).toBeInTheDocument();
    expect(within(list).getByText('Pass')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('t1');
  });
});
