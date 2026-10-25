import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { TruncatedText } from './truncated-text';

const LONG =
  'Which nginx site should I reload? I found default, api.example.com and staging.example.com, and only one of them was changed today.';

/** jsdom has no layout, so every element measures 0 unless told otherwise. */
function pretendOverflow(axis: 'width' | 'height') {
  const spies =
    axis === 'width'
      ? [
          vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(600),
          vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(200),
        ]
      : [
          vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(120),
          vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(40),
        ];
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('TruncatedText', () => {
  it('shows the whole text in a tooltip when one line cuts it off', async () => {
    restore = pretendOverflow('width');
    const { user } = renderWithProviders(<TruncatedText text={LONG} />);
    await user.hover(screen.getByText(LONG));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(LONG);
  });

  it('does the same for text clamped to a few lines', async () => {
    restore = pretendOverflow('height');
    const { user } = renderWithProviders(<TruncatedText text={LONG} lines={2} />);
    const text = screen.getByText(LONG);
    expect(text).toHaveClass('line-clamp-2');
    await user.hover(text);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(LONG);
  });

  it('keeps quiet about text that fits', async () => {
    const { user } = renderWithProviders(<TruncatedText text="Short." />);
    await user.hover(screen.getByText('Short.'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('can be reached with the keyboard only when there is more to read', async () => {
    const { unmount } = renderWithProviders(<TruncatedText text="Short." />);
    expect(screen.getByText('Short.')).not.toHaveAttribute('tabindex');
    unmount();

    restore = pretendOverflow('width');
    const { user } = renderWithProviders(<TruncatedText text={LONG} />);
    expect(screen.getByText(LONG)).toHaveAttribute('tabindex', '0');
    await user.tab();
    // Opened from focus, jsdom's zero-size layout reads as a detached trigger and Radix hides
    // the bubble from the accessibility tree, so the query has to look at hidden nodes too.
    expect(await screen.findByRole('tooltip', { hidden: true })).toHaveTextContent(LONG);
  });

  it('lays Persian out right to left, in the text and in the tooltip', async () => {
    restore = pretendOverflow('width');
    const persian =
      'کدام سایت را دوباره بارگذاری کنم؟ سه سایت پیدا کردم و فقط یکی امروز تغییر کرده است.';
    const { user } = renderWithProviders(<TruncatedText text={persian} />);
    expect(screen.getByText(persian)).toHaveAttribute('dir', 'rtl');
    await user.hover(screen.getByText(persian));
    const tooltip = await screen.findByRole('tooltip');
    // Radix repeats the label in a hidden copy for screen readers; the visible bubble is the parent.
    expect(tooltip.parentElement?.querySelector('[dir="rtl"]')).toHaveTextContent(persian);
  });
});
