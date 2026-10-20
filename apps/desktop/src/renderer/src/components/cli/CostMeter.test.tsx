// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CostMeter } from './CostMeter';

function bars(level: number): HTMLElement[] {
  const { container } = render(<CostMeter level={level} />);
  return Array.from(container.querySelectorAll<HTMLElement>('span > span'));
}

describe('CostMeter', () => {
  it('draws five bars that rise in height and is hidden from screen readers', () => {
    const { container } = render(<CostMeter level={3} />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    const heights = Array.from(container.querySelectorAll<HTMLElement>('span > span')).map((bar) =>
      Number.parseInt(bar.style.height, 10),
    );
    expect(heights).toEqual([6, 8, 10, 12, 14]);
  });

  it('fills the bars up to the level and leaves the rest dim', () => {
    const filled = bars(3).map((bar) => !bar.className.includes('bg-foreground/15'));
    expect(filled).toEqual([true, true, true, false, false]);
  });

  it('turns from green to amber to red as the cost climbs', () => {
    expect(bars(1)[0]?.className).toContain('bg-success');
    expect(bars(2)[1]?.className).toContain('bg-success');
    expect(bars(3)[2]?.className).toContain('bg-warning');
    expect(bars(4)[3]?.className).toContain('bg-destructive');
    expect(bars(5)[4]?.className).toContain('bg-destructive');
  });

  it('passes a class name on to the wrapper', () => {
    const { container } = render(<CostMeter level={2} className="shrink-0" />);
    expect(container.firstElementChild).toHaveClass('shrink-0');
  });
});
