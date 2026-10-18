import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SparklineChart, type SparklineSeries } from './SparklineChart';

/**
 * The chart is plain SVG, so the tests read what it drew straight off the DOM: the `d` of each
 * path, its dash pattern, and the tooltip rows that appear while the pointer is over the plot.
 */

const pct = (v: number): string => `${Math.round(v)}%`;
const celsius = (v: number): string => `${Math.round(v)} °C`;

function renderChart(
  series: SparklineSeries[],
  props: { domainMax?: number; timestamps?: number[] } = {},
) {
  const timestamps = props.timestamps ?? series[0].values.map((_, i) => i * 1000);
  return render(
    <SparklineChart
      timestamps={timestamps}
      series={series}
      height={100}
      domainMin={0}
      domainMax={props.domainMax}
      formatValue={pct}
    />,
  );
}

function chart(): SVGSVGElement {
  return screen.getByRole('img', { name: 'Time series chart' }) as unknown as SVGSVGElement;
}

function paths(): SVGPathElement[] {
  return Array.from(chart().querySelectorAll('path'));
}

/** The line path is the one without a fill, the area path is the filled one. */
function linePaths(): SVGPathElement[] {
  return paths().filter((p) => p.getAttribute('fill') === 'none');
}

/** Points the pointer at sample `index` of `count`, the way a mouse over the plot would. */
function hover(index: number, count: number): void {
  const svg = chart();
  svg.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, height: 100 }) as DOMRect;
  fireEvent.pointerMove(svg, { clientX: (index / (count - 1)) * 300 });
}

/** The value a tooltip row shows next to its series label. */
function tooltipValue(label: string): string {
  const row = screen.getByText(label).parentElement;
  return row?.lastElementChild?.textContent ?? '';
}

describe('SparklineChart', () => {
  it('draws an area and a line per series by default', () => {
    renderChart([{ key: 'cpu', label: 'CPU', color: '#000', values: [10, 20, 30] }], {
      domainMax: 100,
    });

    expect(paths()).toHaveLength(2);
    expect(linePaths()[0].getAttribute('d')?.match(/M/g)).toHaveLength(1);
    expect(linePaths()[0].getAttribute('stroke-dasharray')).toBeNull();
  });

  it('breaks the line where a sample is missing instead of drawing it at zero', () => {
    renderChart(
      [{ key: 't', label: 'Temp', color: '#000', values: [40, 41, Number.NaN, 43, 44] }],
      { domainMax: 100 },
    );

    const d = linePaths()[0].getAttribute('d') ?? '';
    expect(d).not.toContain('NaN');
    // Two runs of finite points, each starting with its own move.
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d.match(/L/g)).toHaveLength(2);
    expect(paths().every((p) => !(p.getAttribute('d') ?? '').includes('NaN'))).toBe(true);
  });

  it('draws a dashed series as a dashed line with no area under it', () => {
    renderChart(
      [
        { key: 'cpu', label: 'CPU', color: '#000', values: [10, 20, 30] },
        {
          key: 'temp',
          label: 'Temperature',
          color: '#f00',
          values: [50, 51, 52],
          dashed: true,
          area: false,
        },
      ],
      { domainMax: 100 },
    );

    // CPU keeps its area and line, the temperature series only adds a line.
    expect(paths()).toHaveLength(3);
    const dashed = paths().filter((p) => p.getAttribute('stroke-dasharray'));
    expect(dashed).toHaveLength(1);
    expect(dashed[0].getAttribute('stroke')).toBe('#f00');
    expect(paths().filter((p) => p.getAttribute('fill') === '#f00')).toHaveLength(0);
  });

  it('formats each tooltip row with the series formatter when it has one', () => {
    renderChart(
      [
        { key: 'cpu', label: 'CPU', color: '#000', values: [10, 34, 30] },
        {
          key: 'temp',
          label: 'Temperature',
          color: '#f00',
          values: [50, 61, 52],
          formatValue: celsius,
        },
      ],
      { domainMax: 100 },
    );

    hover(1, 3);

    expect(tooltipValue('CPU')).toBe('34%');
    expect(tooltipValue('Temperature')).toBe('61 °C');
  });

  it('reads a missing sample as N/A in the tooltip and puts no dot on it', () => {
    const { container } = renderChart(
      [
        { key: 'cpu', label: 'CPU', color: '#000', values: [10, 34, 30] },
        {
          key: 'temp',
          label: 'Temperature',
          color: '#f00',
          values: [50, Number.NaN, 52],
          formatValue: celsius,
        },
      ],
      { domainMax: 100 },
    );

    hover(1, 3);

    expect(tooltipValue('Temperature')).toBe('N/A');
    expect(tooltipValue('CPU')).toBe('34%');
    // Only the CPU series has a point to mark at this sample.
    expect(container.querySelectorAll('div.rounded-full.border-2')).toHaveLength(1);
  });

  it('scales the auto domain to the finite values when some samples are missing', () => {
    renderChart([
      { key: 'disk', label: 'Disk', color: '#000', values: [0, 50, Number.NaN] },
      { key: 'other', label: 'Other', color: '#111', values: [Number.NaN, 25, 0] },
    ]);

    const d = linePaths()[0].getAttribute('d') ?? '';
    expect(d).not.toContain('NaN');
    // 50 is the finite max, so it sits on the top padding line (PAD_Y = 6).
    expect(d).toContain('150.00 6.00');
  });

  it('draws a series with its own scale against that scale, apart from the shared one', () => {
    const { container } = renderChart([
      { key: 'disk', label: 'Disk', color: '#000', values: [0, 4_000_000, 2_000_000] },
      {
        key: 'temp',
        label: 'Disk temp',
        color: '#f00',
        values: [50, 100, 25],
        formatValue: celsius,
        scale: { min: 0, max: 100 },
      },
    ]);

    // The bytes still set the shared auto domain: 4 MB/s is the top, not 100.
    expect(linePaths()[0].getAttribute('d')).toBe('M 0.00 94.00 L 150.00 6.00 L 300.00 50.00');
    // 50 °C sits halfway up its own 0-100 scale and 100 °C at the top, whatever the bytes did.
    expect(linePaths()[1].getAttribute('d')).toBe('M 0.00 50.00 L 150.00 6.00 L 300.00 72.00');

    hover(1, 3);
    // The tooltip still reads the real value, and the dot lands on the series' own line.
    expect(tooltipValue('Disk temp')).toBe('100 °C');
    const dots = Array.from(container.querySelectorAll<HTMLElement>('div.rounded-full.border-2'));
    expect(dots.map((dot) => dot.style.top)).toEqual(['6%', '6%']);
  });
});
