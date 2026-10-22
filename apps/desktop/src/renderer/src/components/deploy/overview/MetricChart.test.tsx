import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricChart } from './MetricChart';

/** The chart's readout: by pointer, by keyboard, and in words for a screen reader. */

const times = [0, 1_000, 2_000, 3_000];
const series = [
  { key: 'rx', label: 'Received', color: '#00994d', values: [10, 20, 30, 40] },
  { key: 'tx', label: 'Sent', color: '#2a78d6', values: [1, 2, 3, 4] },
];

function renderChart(overrides: Partial<Parameters<typeof MetricChart>[0]> = {}) {
  return render(
    <MetricChart
      title="Network"
      times={times}
      series={series}
      yMax={50}
      formatValue={(v) => `${v} B/s`}
      formatTime={(at) => `t${at}`}
      axisTimes={(at) => `a${at}`}
      {...overrides}
    />,
  );
}

describe('MetricChart', () => {
  it('sums up the readings in its label and draws one line per series', () => {
    const { container } = renderChart();
    expect(
      screen.getByRole('img', {
        name: 'Network, 4 readings from t0 to t3000. Latest: Received 40 B/s, Sent 4 B/s.',
      }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll('path[data-series]')).toHaveLength(2);
    expect(screen.getByText('a1500')).toBeInTheDocument();
  });

  it('moves the readout with the arrow keys, Home and End, and hides it on Escape', () => {
    renderChart();
    const plot = screen.getByRole('img');
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('t200030 B/sReceived3 B/sSent');
    fireEvent.keyDown(plot, { key: 'Home' });
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('t0');
    fireEvent.keyDown(plot, { key: 'ArrowRight' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('t1000');
    fireEvent.keyDown(plot, { key: 'End' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('t3000');
    fireEvent.keyDown(plot, { key: 'a' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('t3000');
    fireEvent.keyDown(plot, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.keyDown(plot, { key: 'ArrowRight' });
    fireEvent.blur(plot);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('snaps the crosshair to the reading nearest the pointer', () => {
    renderChart();
    const plot = screen.getByRole('img');
    plot.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, height: 100 }) as DOMRect;
    fireEvent.pointerMove(plot, { clientX: 110 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('t1000');
    fireEvent.pointerMove(plot, { clientX: 290 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('t3000');
    fireEvent.pointerLeave(plot);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('adds a detail line under a series in the readout and in the label', () => {
    const detail = (i: number) => `${i + 1} of 50`;
    renderChart({ series: [{ ...series[0], detail }, series[1]] });
    expect(
      screen.getByRole('img', {
        name: 'Network, 4 readings from t0 to t3000. Latest: Received 40 B/s (4 of 50), Sent 4 B/s.',
      }),
    ).toBeInTheDocument();
    const plot = screen.getByRole('img');
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('t010 B/sReceived1 of 501 B/sSent');
    fireEvent.keyDown(plot, { key: 'ArrowRight' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('t100020 B/sReceived2 of 502 B/sSent');
  });

  it('says when there are no readings and ignores the keys then', () => {
    renderChart({ times: [], series: [{ ...series[0], values: [] }], yMax: 0 });
    const plot = screen.getByRole('img', { name: 'Network: no readings yet' });
    fireEvent.keyDown(plot, { key: 'End' });
    fireEvent.pointerMove(plot, { clientX: 10 });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('draws a single reading at the right edge', () => {
    renderChart({ times: [5], series: [{ ...series[0], values: [7] }] });
    fireEvent.keyDown(screen.getByRole('img'), { key: 'End' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('7 B/s');
  });

  it('shades bands behind the lines, clamped to the plotted time', () => {
    const { container } = renderChart({
      bands: [
        { key: 'inside', from: 1_000, to: 2_000 },
        { key: 'edge', from: -5_000, to: 500 },
        { key: 'outside', from: 4_000, to: 9_000 },
      ],
    });
    const bands = container.querySelectorAll('rect[data-band]');
    expect([...bands].map((band) => band.getAttribute('data-band'))).toEqual(['inside', 'edge']);
    const [inside, edge] = bands;
    // 600 units wide over 3 s of readings, so one second is 200 units.
    expect(inside.getAttribute('x')).toBe('200.0');
    expect(inside.getAttribute('width')).toBe('200.0');
    expect(edge.getAttribute('x')).toBe('0.0');
    expect(edge.getAttribute('width')).toBe('100.0');
    // Behind the lines: every band comes before the first series path.
    const svg = container.querySelector('svg') as SVGSVGElement;
    const order = [...svg.children].map((child) => child.tagName.toLowerCase());
    expect(order.lastIndexOf('rect')).toBeLessThan(order.indexOf('path'));
  });

  it('draws no bands when there are no readings', () => {
    const { container } = renderChart({
      times: [],
      series: [{ ...series[0], values: [] }],
      bands: [{ key: 'b', from: 0, to: 10 }],
    });
    expect(container.querySelectorAll('rect[data-band]')).toHaveLength(0);
  });
});
