import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { WeekInfo } from '@/lib/projectWeekday';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ProjectWeekdayChart } from './ProjectWeekdayChart';
import { projectRow, splitOf, usageOf } from './testing/fixtures';

/**
 * "Projects by weekday", feature by feature. The numbers come from fixtures whose totals are known,
 * so every figure the card shows can be checked against the arithmetic written out in a comment.
 */

const SUNDAY_FIRST: WeekInfo = { firstDay: 0, weekend: [6, 0] };
const MONDAY_FIRST: WeekInfo = { firstDay: 1, weekend: [6, 0] };

/*
 * Per week (Sunday first):
 *   Runova  1000 4000 2000    0    0    0  500   tokens, cost 1 4 2 0 0 0 0.5
 *   Galaxy        0 1000    0 3000    0    0    0   tokens, cost 0 1 0 3 0 0 0
 *   Unknown       0    0    0    0    0  800    0   tokens, cost 0 0 0 0 0 0.8
 * Over four weeks each figure is four times that. Monday is the busiest day in both ranges.
 */
const runova = projectRow({
  key: 'project:p1',
  name: 'Runova',
  path: 'E:/Runova',
  tokens: [1000, 4000, 2000, 0, 0, 0, 500],
  costUsd: [1, 4, 2, 0, 0, 0, 0.5],
});
const galaxy = projectRow({
  key: 'folder:e:/galaxy',
  name: 'Galaxy',
  path: 'E:/Galaxy',
  tokens: [0, 1000, 0, 3000, 0, 0, 0],
  costUsd: [0, 1, 0, 3, 0, 0, 0],
});
const unknown = projectRow({
  key: 'unknown',
  name: 'Unknown folder',
  tokens: [0, 0, 0, 0, 0, 800, 0],
  costUsd: [0, 0, 0, 0, 0, 0.8, 0],
});
const fixtureSplit = splitOf([runova, galaxy, unknown]);

function renderCard(
  bridge: Record<string, unknown>,
  weekInfo: WeekInfo = SUNDAY_FIRST,
  props: { className?: string } = {},
) {
  return renderWithProviders(<ProjectWeekdayChart weekInfo={weekInfo} {...props} />, { bridge });
}

const withData = (split = fixtureSplit) => ({ 'usage.list': [usageOf('claude-code', split)] });

/** The columns, by weekday name, as a screen reader would announce them. */
function columns(): HTMLElement[] {
  return within(screen.getByRole('group', { name: 'Usage by weekday' })).getAllByRole('img');
}

function column(name: RegExp): HTMLElement {
  const found = columns().find((element) => name.test(element.getAttribute('aria-label') ?? ''));
  if (!found) throw new Error(`No column matches ${name}`);
  return found;
}

function legendRow(name: RegExp): HTMLElement {
  return within(screen.getByRole('group', { name: 'Projects' })).getByRole('button', { name });
}

describe('ProjectWeekdayChart states', () => {
  it('shows a per-card skeleton while the usage list loads, and no overlay or empty message', () => {
    renderCard({ 'usage.list': () => new Promise(() => undefined) });

    expect(screen.getByRole('status', { name: 'Loading project usage' })).toBeTruthy();
    expect(screen.queryByText('No project usage yet')).toBeNull();
  });

  it('shows a generic error with a working retry, and never the raw error text', async () => {
    const { user, bridge } = renderCard({
      'usage.list': () => Promise.reject(new Error('scan exploded')),
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Project usage could not be loaded.');
    expect(screen.queryByText(/scan exploded/)).toBeNull();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bridge.$fn('usage.list')).toHaveBeenCalledTimes(2));
  });

  it('explains that there is nothing yet when no provider reports a split', async () => {
    renderCard({ 'usage.list': [usageOf('cursor')] });

    expect(await screen.findByText('No project usage yet')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('offers the 4-week range when nothing was used in the last 7 days', async () => {
    const old = projectRow({
      key: 'folder:e:/old',
      name: 'Archive',
      tokens: [1, 1, 1, 1, 1, 1, 1],
    });
    old.tokens = old.tokens.map((_, i) => (i === 0 ? 900 : 0));
    const { user } = renderCard(withData(splitOf([old])));

    await user.click(await screen.findByRole('button', { name: '7 days' }));

    expect(screen.getByText('Nothing was used in the last 7 days.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show 4 weeks' }));
    expect(screen.getByRole('button', { name: '4 weeks' })).toHaveAttribute('aria-pressed', 'true');
    expect(columns()).toHaveLength(7);
  });

  it('hides the cost toggle when no token has a price, and shows the tokens', async () => {
    const unpriced = projectRow({
      key: 'folder:e:/raw',
      name: 'Raw',
      tokens: [0, 500, 0, 0, 0, 0, 0],
      unpriced: [0, 500, 0, 0, 0, 0, 0],
    });
    renderCard(withData(splitOf([unpriced])));

    await screen.findByRole('group', { name: 'Usage by weekday' });
    expect(screen.queryByRole('button', { name: 'Cost' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tokens' })).toBeNull();
    expect(column(/^Monday/).getAttribute('aria-label')).toContain('Total 2.0K');
  });
});

describe('ProjectWeekdayChart columns', () => {
  it('draws the week from the locale start, Sunday first here', async () => {
    renderCard(withData(), SUNDAY_FIRST);
    await screen.findByRole('group', { name: 'Usage by weekday' });

    expect(
      columns().map((element) => /^[A-Za-z]+/.exec(element.getAttribute('aria-label') ?? '')?.[0]),
    ).toEqual(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  });

  it('draws the week from Monday when the locale starts there', async () => {
    renderCard(withData(), MONDAY_FIRST);
    await screen.findByRole('group', { name: 'Usage by weekday' });

    expect(columns()[0]).toHaveAttribute('data-weekday', '1');
    expect(columns()[6]).toHaveAttribute('data-weekday', '0');
  });

  it('shades the weekend and marks today, which is the end of the window', async () => {
    renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    expect(column(/^Sunday/)).toHaveAttribute('data-weekend');
    expect(column(/^Saturday/)).toHaveAttribute('data-weekend');
    expect(column(/^Monday/)).not.toHaveAttribute('data-weekend');
    expect(column(/^Tuesday, today/)).toHaveAttribute('data-today');
  });

  it('stacks each project in its colour slot, and sizes the segments by their tokens', async () => {
    renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    // Monday over four weeks: Runova 16000 tokens (bottom), Galaxy 4000 (top).
    const monday = column(/^Monday/);
    const segments = Array.from(monday.querySelectorAll<HTMLElement>('[data-series]'));
    expect(segments.map((segment) => segment.dataset.series)).toEqual([
      'project:p1',
      'folder:e:/galaxy',
    ]);
    expect(segments.map((segment) => segment.style.flexGrow)).toEqual(['16000', '4000']);
    expect(segments[0].style.backgroundColor).not.toBe('');
  });

  it('gives each column a height that is its share of the axis', async () => {
    renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    // Monday is the tallest column, so it reaches the top of the axis. Friday is 3,200 of 20,000.
    expect((column(/^Monday/).firstElementChild as HTMLElement).style.height).toBe('100%');
    const friday = (column(/^Friday/).firstElementChild as HTMLElement).style.height;
    expect(Number.parseFloat(friday)).toBeCloseTo(16, 6);
  });

  it('describes each column with its total, its projects and its average', async () => {
    renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    expect(column(/^Monday/).getAttribute('aria-label')).toBe(
      'Monday. Total 20.0K, average 5.0K per Monday. Runova 16.0K, Galaxy 4.0K.',
    );
  });

  it('keeps the bars at their weight in the 7-day range, where each weekday is counted once', async () => {
    const { user } = renderCard(withData());
    await user.click(await screen.findByRole('button', { name: '7 days' }));

    // Monday in the last 7 days: 4000 + 1000.
    expect(column(/^Monday/).getAttribute('aria-label')).toBe(
      'Monday (Oct 12). Total 5.0K. Runova 4.0K, Galaxy 1.0K.',
    );
    expect((column(/^Monday/).firstElementChild as HTMLElement).style.height).toBe('62.5%');
  });

  it('folds every project past the sixth into Other', async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      projectRow({
        key: `folder:e:/p${i}`,
        name: `Project ${i}`,
        tokens: [0, 1000 * (8 - i), 0, 0, 0, 0, 0],
      }),
    );
    renderCard(withData(splitOf(many)));
    await screen.findByRole('group', { name: 'Projects' });

    const legend = screen.getByRole('group', { name: 'Projects' });
    expect(within(legend).getAllByRole('button')).toHaveLength(7);
    expect(within(legend).getByRole('button', { name: /Other \(2\)/ })).toBeTruthy();
  });

  it('shows two projects that share a name with their parent folder', async () => {
    const twins = [
      projectRow({
        key: 'project:a',
        name: 'Runova',
        path: 'E:/Runova',
        tokens: [0, 1, 0, 0, 0, 0, 0],
      }),
      projectRow({
        key: 'project:b',
        name: 'Runova',
        path: 'D:/Old/Runova',
        tokens: [0, 1, 0, 0, 0, 0, 0],
      }),
    ];
    renderCard(withData(splitOf(twins)));

    expect(await screen.findByRole('button', { name: /Runova \(E:\)/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Runova \(Old\)/ })).toBeTruthy();
  });
});

describe('ProjectWeekdayChart tooltips', () => {
  it('shows the day, every project on it, the total and the average on hover', async () => {
    const { user } = renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    await user.hover(column(/^Monday/));
    // Radix may render the tooltip's text twice, so the sentence is the thing to wait for.
    const [average] = await screen.findAllByText(/Average 5.0K per Monday/);
    const tip = average.closest<HTMLElement>('.min-w-44');
    expect(tip).toHaveTextContent('Monday');
    expect(tip).toHaveTextContent('Runova');
    expect(tip).toHaveTextContent('16.0K');
    expect(tip).toHaveTextContent('Total');
  });

  it('opens the same tooltip from the keyboard', async () => {
    renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    act(() => column(/^Monday/).focus());

    const tips = await screen.findAllByRole('tooltip');
    expect(tips[0]).toHaveTextContent('Monday');
  });
});

describe('ProjectWeekdayChart keyboard', () => {
  it('starts on the busiest day and moves with the arrow, Home and End keys', async () => {
    const { user } = renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    const monday = column(/^Monday/);
    expect(monday).toHaveAttribute('tabindex', '0');
    expect(column(/^Tuesday/)).toHaveAttribute('tabindex', '-1');

    act(() => monday.focus());
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(column(/^Tuesday/));

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(column(/^Saturday/));

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(column(/^Sunday/));

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(column(/^Saturday/));
  });
});

describe('ProjectWeekdayChart controls', () => {
  it('switches the figures to cost, and the legend follows', async () => {
    const { user } = renderCard(withData());
    await screen.findByRole('button', { name: 'Cost' });

    await user.click(screen.getByRole('button', { name: 'Cost' }));

    expect(screen.getByRole('button', { name: 'Cost' })).toHaveAttribute('aria-pressed', 'true');
    expect(legendRow(/Runova/)).toHaveTextContent('$');
    expect(column(/^Monday/).getAttribute('aria-label')).toContain('Total $20.00');
  });

  it('keeps each project in its colour across the metric and the range', async () => {
    const { user } = renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });
    const colourOf = () =>
      column(/^Monday/).querySelector<HTMLElement>('[data-series="project:p1"]')?.style
        .backgroundColor;
    const before = colourOf();

    await user.click(screen.getByRole('button', { name: 'Cost' }));
    await user.click(screen.getByRole('button', { name: '7 days' }));

    expect(before).toBeTruthy();
    expect(colourOf()).toBe(before);
  });

  it('switches between the 4-week and the 7-day range', async () => {
    const { user } = renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    expect(column(/^Monday/).getAttribute('aria-label')).toContain('Total 20.0K');
    await user.click(screen.getByRole('button', { name: '7 days' }));
    expect(column(/^Monday/).getAttribute('aria-label')).toContain('Total 5.0K');
    expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the busiest day and the top project in the summary', async () => {
    renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    expect(screen.getByText('Busiest day').parentElement).toHaveTextContent('Monday');
    expect(screen.getByText('Top project').parentElement).toHaveTextContent('Runova');
  });

  it('shows one project alone when it is soloed, and restores the rest on a second click', async () => {
    const { user } = renderCard(withData());
    await screen.findByRole('group', { name: 'Projects' });

    await user.click(legendRow(/Runova/));
    expect(legendRow(/Runova/)).toHaveAttribute('aria-pressed', 'true');
    const shown = Array.from(
      document.querySelectorAll<HTMLElement>('[data-series]'),
      (node) => node.dataset.series,
    );
    expect(new Set(shown)).toEqual(new Set(['project:p1']));
    expect(screen.getByText('Share of total')).toBeTruthy();

    await user.click(legendRow(/Runova/));
    expect(legendRow(/Runova/)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Top project')).toBeTruthy();
  });

  it('drops a solo when its project falls out of the range', async () => {
    const archive = projectRow({
      key: 'folder:e:/archive',
      name: 'Archive',
      tokens: [1, 1, 1, 1, 1, 1, 1],
    });
    archive.tokens = archive.tokens.map((_, i) => (i === 0 ? 700 : 0));
    const { user } = renderCard(withData(splitOf([runova, archive])));

    await user.click(await screen.findByRole('button', { name: /Archive/ }));
    expect(legendRow(/Archive/)).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: '7 days' }));

    expect(screen.queryByRole('button', { name: /Archive/ })).toBeNull();
    expect(screen.getByText('Top project')).toBeTruthy();
    expect(legendRow(/Runova/)).toHaveAttribute('aria-pressed', 'false');
  });

  it('dims the other projects while one is hovered', async () => {
    const { user } = renderCard(withData());
    await screen.findByRole('group', { name: 'Projects' });

    await user.hover(legendRow(/Galaxy/));

    const dimmed = column(/^Monday/).querySelector<HTMLElement>('[data-series="project:p1"]');
    const emphasised = column(/^Monday/).querySelector<HTMLElement>(
      '[data-series="folder:e:/galaxy"]',
    );
    expect(dimmed?.style.opacity).toBe('0.3');
    expect(emphasised?.style.opacity).toBe('1');
  });

  it('switches to a table of every project and back again', async () => {
    const { user } = renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    await user.click(screen.getByRole('button', { name: 'Table' }));

    const table = screen.getByRole('table');
    expect(within(table).getByRole('caption')).toHaveTextContent(
      'Tokens by project and weekday, last 4 weeks',
    );
    expect(within(table).getByRole('rowheader', { name: 'Runova' })).toBeTruthy();
    expect(within(table).getByRole('rowheader', { name: 'Unknown folder' })).toBeTruthy();
    expect(within(table).getByRole('rowheader', { name: 'All projects' })).toBeTruthy();
    const mondayCell = within(table).getAllByRole('row')[1].querySelectorAll('td')[1];
    expect(mondayCell).toHaveTextContent('16.0K');

    await user.click(screen.getByRole('button', { name: 'Chart' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('group', { name: 'Usage by weekday' })).toBeTruthy();
  });
});

describe('ProjectWeekdayChart summary and notes', () => {
  it('states that cost is an estimate and that totals can differ from the All agents card', async () => {
    renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    expect(screen.getByText(/Cost is an estimate at list prices/)).toBeTruthy();
    expect(screen.getByText(/Totals can differ from the All agents card/)).toBeTruthy();
  });

  it('says how much of the usage ran in no known folder, once it is 5% or more', async () => {
    renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    // 3,200 of 49,200 tokens is 6.5%, which rounds to 7%.
    expect(screen.getByText(/7% of the tokens ran in no known folder/)).toBeTruthy();
  });

  it('notes the models that have no price, and that their cost is a minimum', async () => {
    const partial = projectRow({
      key: 'project:p1',
      name: 'Runova',
      tokens: [100, 0, 0, 0, 0, 0, 0],
      costUsd: [0.5, 0, 0, 0, 0, 0, 0],
      unpriced: [50, 0, 0, 0, 0, 0, 0],
    });
    renderCard(withData(splitOf([partial])));

    expect(await screen.findByText(/Some models have no known price/)).toBeTruthy();
  });

  it('keeps the chart free of native title tooltips and of injected markup', async () => {
    const hostile = projectRow({
      key: 'folder:e:/hostile',
      name: '<img src=x onerror=alert(1)>',
      tokens: [0, 5, 0, 0, 0, 0, 0],
    });
    const { container } = renderCard(withData(splitOf([hostile])));

    // The name shows in the summary and in the legend, as plain text in both places.
    expect((await screen.findAllByText('<img src=x onerror=alert(1)>')).length).toBeGreaterThan(0);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('draws its bars at their final height straight away when motion is reduced', async () => {
    renderCard(withData());
    await screen.findByRole('group', { name: 'Usage by weekday' });

    const grow = column(/^Monday/).firstElementChild as HTMLElement;
    expect(grow.className).toContain('motion-reduce:transition-none');
    expect(grow.style.height).toBe('100%');
  });
});
