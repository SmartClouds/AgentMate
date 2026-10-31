import { screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { DomainChips } from './DomainChips';

/**
 * The domains a key works on, as chips. People paste URLs and lists; the chips hold bare domains,
 * say plainly what could not be used, and turn localhost on with a switch for testing.
 */

function Harness({
  initial = [] as string[],
  max,
  localhostSwitch,
}: {
  initial?: string[];
  max?: number;
  localhostSwitch?: boolean;
}) {
  const [domains, setDomains] = useState<string[]>(initial);
  return (
    <>
      <DomainChips
        id="domains"
        domains={domains}
        onChange={setDomains}
        max={max}
        localhostSwitch={localhostSwitch}
      />
      <output data-testid="value">{domains.join(',')}</output>
    </>
  );
}

const value = () => screen.getByTestId('value').textContent;

describe('DomainChips', () => {
  it('adds a typed domain on Enter or comma, cleaned up', async () => {
    const { user } = renderWithProviders(<Harness />);
    const input = screen.getByRole('textbox', { name: 'Domains' });
    await user.type(input, 'https://Shop.com/cart{Enter}');
    await user.type(input, 'www.shop.com,');
    expect(value()).toBe('shop.com,www.shop.com');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('takes a pasted list, keeps what it can and says what it cannot', async () => {
    const { user } = renderWithProviders(<Harness initial={['a.com']} />);
    const input = screen.getByRole('textbox', { name: 'Domains' });
    await user.click(input);
    await user.paste('a.com b.com 10.0.0.1 nope');
    expect(value()).toBe('a.com,b.com');
    expect(screen.getByText(/10\.0\.0\.1: Use a domain, not an IP address/)).toBeTruthy();
    expect(screen.getByText(/nope: Type the full domain/)).toBeTruthy();
  });

  it('adds what is typed when the field loses focus', async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.type(screen.getByRole('textbox', { name: 'Domains' }), 'blog.com');
    await user.tab();
    expect(value()).toBe('blog.com');
  });

  it('removes a chip with its button, or the last one with Backspace', async () => {
    const { user } = renderWithProviders(<Harness initial={['a.com', 'b.com', 'c.com']} />);
    await user.click(screen.getByRole('button', { name: 'Remove b.com' }));
    expect(value()).toBe('a.com,c.com');
    await user.click(screen.getByRole('textbox', { name: 'Domains' }));
    await user.keyboard('{Backspace}');
    expect(value()).toBe('a.com');
  });

  it('turns localhost on and off with its switch', async () => {
    const { user } = renderWithProviders(<Harness initial={['a.com']} />);
    const toggle = screen.getByRole('switch', { name: 'Allow localhost for testing' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(value()).toBe('a.com,localhost');
    expect(screen.queryByRole('button', { name: 'Remove localhost' })).toBeNull();
    await user.click(toggle);
    expect(value()).toBe('a.com');
  });

  it('says that subdomains come along', () => {
    renderWithProviders(<Harness initial={['a.com']} />);
    expect(screen.getByText(/Subdomains of each domain work too/)).toBeTruthy();
  });

  it('keeps to a smaller limit and says why the rest were left out', async () => {
    const { user } = renderWithProviders(<Harness initial={['a.com']} max={2} />);
    await user.click(screen.getByRole('textbox', { name: 'Domains' }));
    await user.paste('b.com c.com d.com');
    expect(value()).toBe('a.com,b.com');
    expect(screen.getByText('Only 2 domains fit, so c.com and d.com were left out.')).toBeTruthy();
    expect(screen.getByText('2 of 2')).toBeTruthy();
  });

  it('can treat localhost as a plain domain, without the switch', async () => {
    const { user } = renderWithProviders(<Harness initial={['a.com']} localhostSwitch={false} />);
    expect(screen.queryByRole('switch')).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'Domains' }), 'localhost{Enter}');
    expect(value()).toBe('a.com,localhost');
    expect(screen.getByRole('button', { name: 'Remove localhost' })).toBeTruthy();
  });
});
