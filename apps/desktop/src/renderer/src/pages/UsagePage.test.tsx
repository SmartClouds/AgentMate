import {
  getUsageProvider,
  type ProviderUsage,
  type SubscriptionUsage,
  USAGE_PROVIDER_REGISTRY,
  type UsagePeriod,
  type UsageSegment,
} from '@runova/core';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readableAccent } from '@/lib/chartColors';
import { useDashboardLayoutStore } from '@/stores/dashboardLayoutStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';
import { projectRow, splitOf } from '../components/usage/weekday/testing/fixtures';

/**
 * Token Usage is a page of cards fed by one scan: six providers connect themselves from local
 * data and the rest have to be added with a key. The tests drive it the way the page is used, by
 * reading the totals, flipping the period, adding and removing a provider, and checking that a
 * scan that fell over says so on the card instead of blanking the page.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/stores/confirmStore', () => confirm);

/**
 * The renderer suite already swaps Framer Motion for a stub, but that stub is missing the two
 * pieces this page's cards reach for: `useMotionValueEvent`, which the count-up headline
 * subscribes with, and `jump` on a motion value. Reduced motion is on in the stub, so the
 * numbers render in full immediately and none of this animates.
 */
vi.mock('framer-motion', async (importOriginal) => {
  const stub = (await importOriginal()) as Record<string, unknown>;
  const motionValue = (initial: number) => {
    let current = initial;
    return {
      get: () => current,
      set: (next: number) => {
        current = next;
      },
      jump: (next: number) => {
        current = next;
      },
      on: () => () => undefined,
    };
  };
  return {
    ...stub,
    useMotionValue: motionValue,
    useSpring: motionValue,
    useTransform: () => motionValue(0),
    useMotionValueEvent: () => undefined,
  };
});

const { default: UsagePage } = await import('./UsagePage');

function period(total: number, costUsd: number | null = null): UsagePeriod {
  return { tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total }, costUsd };
}

function usage(overrides: Partial<ProviderUsage> & { providerId: string }): ProviderUsage {
  return {
    status: 'ok',
    today: period(0),
    last7d: period(0),
    last30d: period(0),
    currency: 'USD',
    updatedAt: '2026-04-01T12:00:00.000Z',
    ...overrides,
  };
}

// Figures picked so every formatted number on the page is distinguishable: 1.0K + 500 today,
// 7.0K + 2.0K this week, and $0.50 + $0.25 of cost.
const claudeUsage = usage({
  providerId: 'claude-code',
  today: period(1_000, 0.5),
  last7d: period(7_000, 3),
  last30d: period(30_000, 12),
  series: [10, 20, 30],
  costSeries: [0.1, 0.2, 0.3],
});

const codexUsage = usage({
  providerId: 'codex',
  today: period(500, 0.25),
  last7d: period(2_000, 1),
  last30d: period(8_000, 4),
  series: [40, 50, 60],
});

const subscription: SubscriptionUsage = {
  mode: 'subscription',
  plan: { id: 'pro', label: 'Pro' },
  source: 'account',
  windows: [
    { key: 'session', label: 'Session (5h)', percent: 42, resetAt: null },
    { key: 'week', label: 'Weekly', percent: 12, resetAt: null },
  ],
};

function renderPage(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<UsagePage />, { route: '/usage', bridge });
}

/** The combined card at the top of the page. */
function allAgentsCard(): HTMLElement {
  const card = screen.getByText('All agents').closest('div.glass');
  if (!card) throw new Error('No All agents card on the page');
  return card as HTMLElement;
}

/**
 * One provider's card. Every provider is also named in the All agents breakdown above, so that
 * card is skipped rather than matching first.
 */
function cardFor(name: string): HTMLElement {
  const combined = screen.queryByText('All agents')?.closest('div.glass') ?? null;
  const title = screen.getAllByText(name).find((node) => !combined?.contains(node));
  const card = title?.closest('div.glass');
  if (!card) throw new Error(`No card found around "${name}"`);
  return card as HTMLElement;
}

/**
 * The headline row a card leads with: the big token figure and the window it covers. The same
 * figures repeat in the day/week/month comparison below, so assertions aim at this row.
 */
function headlineFor(card: HTMLElement, label: string): HTMLElement {
  const text = within(card).getByText(label);
  if (!text.parentElement) throw new Error(`No headline row around "${label}"`);
  return text.parentElement;
}

/** The value a summary tile currently shows, read next to its label. */
function tileValue(label: string): string {
  const tile = screen.getByText(label).parentElement?.parentElement;
  if (!tile) throw new Error(`No tile around "${label}"`);
  return tile.lastElementChild?.textContent ?? '';
}

/**
 * What an inline hex resolves to in this DOM, so accent assertions compare
 * against the serialized value rather than the authored hex.
 */
function cssColor(hex: string): string {
  const probe = document.createElement('div');
  probe.style.color = hex;
  return probe.style.color;
}

describe('UsagePage with nothing behind it', () => {
  it('still offers the six providers that connect themselves', async () => {
    renderPage();

    // Claude Code, Codex, Cursor, GitHub Copilot, OpenCode and Gemini CLI read local data, so
    // they are on the page without a key.
    expect(await screen.findByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Cursor')).toBeTruthy();
    expect(screen.getByText('GitHub Copilot')).toBeTruthy();
    expect(screen.getByText('OpenCode')).toBeTruthy();
    expect(screen.getByText('Gemini CLI')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add provider' })).toBeTruthy();
    await waitFor(() =>
      expect(tileValue('Providers tracked')).toBe(`6/${USAGE_PROVIDER_REGISTRY.length}`),
    );
  });

  it('says there is nothing to combine yet instead of drawing an empty chart', async () => {
    renderPage({ 'settings.get': {}, 'usage.list': [] });

    expect(
      await screen.findByText(
        'Track a provider to see combined usage, averages, and cost across your agents.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Time series chart' })).toBeNull();
    await waitFor(() => expect(tileValue('Tokens today')).toBe('0'));
    expect(tileValue('Cost today')).toBe('$0.00');
  });

  it('puts the failure on the cards rather than replacing the page with an error', async () => {
    renderPage({
      'settings.get': {},
      'usage.list': () => Promise.reject(new Error('usage scan crashed')),
    });

    const messages = await screen.findAllByText('usage scan crashed');
    // One per tracked provider's card; the page's toolbar and tiles are all still there.
    expect(messages).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });
});

describe('UsagePage totals and charts', () => {
  it('adds up tokens and cost across the tracked providers', async () => {
    renderPage({ 'settings.get': {}, 'usage.list': [claudeUsage, codexUsage] });

    await waitFor(() => expect(tileValue('Tokens today')).toBe('1.5K'));
    expect(tileValue('Tokens (7 days)')).toBe('9.0K');
    // 0.50 + 0.25, formatted as money rather than a raw float.
    expect(tileValue('Cost today')).toBe('$0.75');
  });

  it('renders the combined trend chart once there is a series to draw', async () => {
    renderPage({ 'settings.get': {}, 'usage.list': [claudeUsage, codexUsage] });

    await screen.findByText('All agents');
    // The combined chart plus one per provider card that reported a series.
    await waitFor(() =>
      expect(screen.getAllByRole('img', { name: 'Time series chart' }).length).toBeGreaterThan(1),
    );
    const allAgents = allAgentsCard();
    // One line for tokens and one for cost, since at least one provider could price its calls.
    expect(within(allAgents).getAllByRole('img', { name: 'Time series chart' })).toHaveLength(2);
    expect(within(allAgents).getByText('14-day trend across all agents')).toBeTruthy();
  });

  it('switches the All agents headline between the day, week and month windows', async () => {
    const { user } = renderPage({ 'settings.get': {}, 'usage.list': [claudeUsage, codexUsage] });

    await screen.findByText('All agents');
    const allAgents = allAgentsCard();
    // Week is the card's own default, so it opens on the seven-day total: 7.0K + 2.0K.
    await waitFor(() =>
      expect(within(headlineFor(allAgents, 'tokens this week')).getByText('9.0K')).toBeTruthy(),
    );

    await user.click(within(allAgents).getByRole('tab', { name: 'Day' }));

    expect(within(headlineFor(allAgents, 'tokens today')).getByText('1.5K')).toBeTruthy();

    await user.click(within(allAgents).getByRole('tab', { name: 'Month' }));

    expect(within(headlineFor(allAgents, 'tokens this month')).getByText('38.0K')).toBeTruthy();
  });

  it('gives each provider card its own period selector', async () => {
    const { user } = renderPage({ 'settings.get': {}, 'usage.list': [claudeUsage, codexUsage] });

    await screen.findByText('Claude Code');
    const card = cardFor('Claude Code');
    // A provider card opens on today, unlike the combined one.
    await waitFor(() => expect(within(card).getByText('tokens today')).toBeTruthy());

    await user.click(within(card).getByRole('tab', { name: 'Week' }));

    expect(within(card).getByText('tokens this week')).toBeTruthy();
    // The other card is untouched, each one remembers its own window.
    expect(within(cardFor('Codex')).getByText('tokens today')).toBeTruthy();
  });
});

describe('UsagePage provider management', () => {
  it('adds an API provider with the key that was typed for it', async () => {
    const { user, bridge } = renderPage({ 'settings.get': {}, 'usage.list': [] });
    await screen.findByText('Claude Code');

    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText(/Search 65 providers/), 'openai');

    // "openai" also matches Azure OpenAI, so the row is found by its exact name.
    const row = within(dialog)
      .getByText('OpenAI', { selector: 'span' })
      .closest('div.rounded-lg') as HTMLElement;
    await user.type(within(row).getByPlaceholderText('API key'), 'sk-test-123');
    await user.click(within(row).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(bridge.$fn('usage.setProviderConfig')).toHaveBeenCalledWith('openai', {
        enabled: true,
        apiKey: 'sk-test-123',
      }),
    );
  });

  it('marks the self-connecting providers as automatic so there is no key to paste', async () => {
    const { user } = renderPage({ 'settings.get': {}, 'usage.list': [] });
    await screen.findByText('Claude Code');

    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText(/Search 65 providers/), 'claude');

    expect(within(dialog).getByText('Local logs · automatic')).toBeTruthy();
    expect(within(dialog).getByText('Auto')).toBeTruthy();
    expect(within(dialog).queryByPlaceholderText('API key')).toBeNull();
  });

  it('drops a provider the user added, and never offers that for an automatic one', async () => {
    const { user, bridge } = renderPage({
      'settings.get': { usageProviderConfigs: { openai: { enabled: true, apiKey: 'sk-old' } } },
      'usage.list': [usage({ providerId: 'openai', today: period(250, 1) })],
    });

    await screen.findByText('OpenAI');
    const openai = cardFor('OpenAI');
    // [add to dashboard, add to desktop, remove]: remove is the last action, and only a
    // provider the user configured has one.
    const buttons = within(openai).getAllByRole('button');
    expect(buttons).toHaveLength(3);
    await user.click(buttons[2]);

    await waitFor(() =>
      expect(bridge.$fn('usage.setProviderConfig')).toHaveBeenCalledWith('openai', {
        enabled: false,
        apiKey: 'sk-old',
      }),
    );
    // Claude Code reads local logs, so it has no remove action at all: it would come straight
    // back on the next scan. Its buttons are [reset alerts, threshold alerts, dashboard, desktop].
    expect(within(cardFor('Claude Code')).getAllByRole('button')).toHaveLength(4);
  });

  it('re-scans everything when the user asks for a refresh', async () => {
    const { user, bridge } = renderPage({ 'settings.get': {}, 'usage.list': [claudeUsage] });
    await screen.findByText('Claude Code');

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(bridge.$fn('usage.refresh')).toHaveBeenCalled());
    expect(toast.info).toHaveBeenCalledWith('Refreshing usage…');
  });
});

describe('UsagePage card views', () => {
  it('flips a subscription card between tokens and the plan limits', async () => {
    const { user, bridge } = renderPage({
      'settings.get': {},
      'usage.list': [usage({ providerId: 'cursor', today: period(300, 2), subscription })],
    });

    await screen.findByText('Cursor');
    const card = cardFor('Cursor');
    await waitFor(() => expect(within(card).getByText('tokens today')).toBeTruthy());
    // Cursor connects itself, so its only actions are [plan limits, dashboard, desktop].
    await user.click(within(card).getAllByRole('button')[0]);

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        usageCardModes: { cursor: 'subscription' },
      }),
    );
  });

  it('draws the plan limits and the plan badge when the card is in that mode', async () => {
    renderPage({
      'settings.get': { usageCardModes: { cursor: 'subscription' } },
      'usage.list': [usage({ providerId: 'cursor', today: period(300, 2), subscription })],
    });

    await screen.findByText('Cursor');
    const card = cardFor('Cursor');
    await waitFor(() => expect(within(card).getByText('Session (5h)')).toBeTruthy());
    expect(within(card).getByText('42%')).toBeTruthy();
    expect(within(card).getByText('Weekly')).toBeTruthy();
    expect(within(card).getByText('Pro')).toBeTruthy();
    expect(within(card).getByText('300 tokens today')).toBeTruthy();
  });

  it('draws the Copilot card with its Cost section and feature split, like Codex', async () => {
    const segment = (key: string, label: string, total: number, costUsd: number): UsageSegment => ({
      key,
      label,
      tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
      costUsd,
    });
    renderPage({
      'settings.get': {},
      'usage.list': [
        usage({
          providerId: 'copilot',
          today: {
            ...period(4_250, 0.42),
            segments: [
              segment('chat', 'Chat', 1_500, 0.2),
              segment('completions', 'Code completions', 2_500, 0.2),
              segment('cli', 'CLI', 250, 0.02),
            ],
          },
          last7d: period(9_250, 0.9),
          last30d: period(30_000, 3),
          series: [100, 200, 300, 400],
          costSeries: [0.01, 0.02, 0.03, 0.04],
        }),
      ],
    });

    await screen.findByText('GitHub Copilot');
    const card = cardFor('GitHub Copilot');
    await waitFor(() => expect(within(card).getByText('tokens today')).toBeTruthy());
    // Headline cost and the Cost comparison column both show today's cost.
    expect(within(card).getAllByText('$0.42')).toHaveLength(2);
    expect(within(card).getByText('Cost')).toBeTruthy();
    expect(within(card).getByText('Chat')).toBeTruthy();
    expect(within(card).getByText('Code completions')).toBeTruthy();
    expect(within(card).getByText('CLI')).toBeTruthy();
    // Cost leads the headline, usage follows it.
    const headline = headlineFor(card, 'tokens today');
    const headlineCost = within(headline).getByText('$0.42');
    const headlineTokens = within(headline).getByText('4.3K');
    expect(
      headlineCost.compareDocumentPosition(headlineTokens) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('draws a Cursor card whose read failed with its plan limits and a note in place of the tokens', async () => {
    renderPage({
      'settings.get': { usageCardModes: { cursor: 'subscription' } },
      'usage.list': [
        usage({
          providerId: 'cursor',
          status: 'error',
          error: 'Cursor did not answer in time.',
          subscription,
        }),
      ],
    });

    await screen.findByText('Cursor');
    const card = cardFor('Cursor');
    await waitFor(() => expect(within(card).getByText('Session (5h)')).toBeTruthy());
    expect(within(card).getByText('Token totals could not be loaded')).toBeTruthy();
    expect(within(card).queryByText(/tokens today/)).toBeNull();
  });

  it('keeps the error text on a failed Cursor card in the tokens view', async () => {
    renderPage({
      'settings.get': {},
      'usage.list': [
        usage({
          providerId: 'cursor',
          status: 'error',
          error: 'Cursor did not answer in time.',
          subscription,
        }),
      ],
    });

    await screen.findByText('Cursor');
    const card = cardFor('Cursor');
    await waitFor(() =>
      expect(within(card).getByText('Cursor did not answer in time.')).toBeTruthy(),
    );
  });

  it('draws the OpenCode card with the same chart UI as a Codex card', async () => {
    const { user } = renderPage({
      'settings.get': {},
      'usage.list': [
        usage({
          providerId: 'opencode',
          today: period(4_250, 0.42),
          last7d: period(9_250, 0.9),
          last30d: period(30_000, 3),
          series: [100, 200, 300, 400],
          costSeries: [0.01, 0.02, 0.03, 0.04],
        }),
      ],
    });

    await screen.findByText('OpenCode');
    const card = cardFor('OpenCode');
    await waitFor(() => expect(within(card).getByText('tokens today')).toBeTruthy());

    // Day / Week / Month chips switch the headline window, like every other card.
    expect(within(card).getByRole('tab', { name: 'Day' })).toBeTruthy();
    expect(within(card).getByRole('tab', { name: 'Week' })).toBeTruthy();
    expect(within(card).getByRole('tab', { name: 'Month' })).toBeTruthy();

    // Headline cost and the Cost comparison column both show today's cost.
    expect(within(card).getAllByText('$0.42')).toHaveLength(2);
    expect(within(card).getByText('Cost')).toBeTruthy();
    expect(within(card).getByText('Usage')).toBeTruthy();
    // Cost leads the headline, usage follows it.
    const headline = headlineFor(card, 'tokens today');
    const headlineCost = within(headline).getByText('$0.42');
    const headlineTokens = within(headline).getByText('4.3K');
    expect(
      headlineCost.compareDocumentPosition(headlineTokens) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The week window adds a per-day average under the headline.
    await user.click(within(card).getByRole('tab', { name: 'Week' }));
    expect(within(card).getByText('tokens this week')).toBeTruthy();
    expect(within(card).getByText(/avg .* \/ day/)).toBeTruthy();

    await user.click(within(card).getByRole('tab', { name: 'Month' }));
    expect(within(card).getByText('tokens this month')).toBeTruthy();
    expect(within(headlineFor(card, 'tokens this month')).getByText('30.0K')).toBeTruthy();

    // The 14-day token sparkline and its footer read from the same series.
    expect(within(card).getByRole('img', { name: 'Time series chart' })).toBeTruthy();
    expect(within(card).getByText('14-day trend')).toBeTruthy();
    expect(within(card).getByText(/7d /)).toBeTruthy();

    // OpenCode connects itself, so its only actions are [dashboard, desktop]:
    // no plan-limits toggle without subscription windows, no key, no remove.
    expect(within(card).getAllByRole('button')).toHaveLength(2);

    // The combined card above counts OpenCode in its per-agent breakdown.
    expect(within(allAgentsCard()).getByText('OpenCode')).toBeTruthy();
  });

  it('draws the Gemini CLI card with the Codex chart UI in the Gemini accent', async () => {
    const { user } = renderPage({
      'settings.get': {},
      'usage.list': [
        claudeUsage,
        usage({
          providerId: 'gemini-cli',
          today: period(4_250, 0.42),
          last7d: period(9_250, 0.9),
          last30d: period(30_000, 3),
          series: [100, 200, 300, 400],
          costSeries: [0.01, 0.02, 0.03, 0.04],
        }),
      ],
    });

    await screen.findByText('Gemini CLI');
    const card = cardFor('Gemini CLI');
    await waitFor(() => expect(within(card).getByText('tokens today')).toBeTruthy());

    // The registry's Gemini blue, as readable on this theme, is what every
    // painted element in the chart carries.
    expect(getUsageProvider('gemini-cli')?.accentColor).toBe('#1C69FF');
    const gemini = cssColor(readableAccent('#1C69FF', false));

    // Day / Week / Month chips switch the headline window, like every other card.
    expect(within(card).getByRole('tab', { name: 'Day' })).toBeTruthy();
    expect(within(card).getByRole('tab', { name: 'Week' })).toBeTruthy();
    expect(within(card).getByRole('tab', { name: 'Month' })).toBeTruthy();

    // Headline cost and the Cost comparison column both show today's cost.
    expect(within(card).getAllByText('$0.42')).toHaveLength(2);
    expect(within(card).getByText('Cost')).toBeTruthy();
    expect(within(card).getByText('Usage')).toBeTruthy();
    // Cost leads the headline, usage follows it.
    const headline = headlineFor(card, 'tokens today');
    const headlineCost = within(headline).getByText('$0.42');
    const headlineTokens = within(headline).getByText('4.3K');
    expect(
      headlineCost.compareDocumentPosition(headlineTokens) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The headline cost wears the Gemini accent, and it is not Claude's. The figure itself
    // is a CountUp span, so the accent sits on its parent.
    expect((headlineCost.parentElement as HTMLElement).style.color).toBe(gemini);
    const claudeHeadline = headlineFor(cardFor('Claude Code'), 'tokens today');
    expect(
      (within(claudeHeadline).getByText('$0.50').parentElement as HTMLElement).style.color,
    ).not.toBe(gemini);

    // Every Usage and Cost compare bar shares the same accent.
    const bars = [...card.querySelectorAll('.bar-shine')];
    expect(bars).toHaveLength(6);
    for (const bar of bars) expect((bar as HTMLElement).style.backgroundColor).toBe(gemini);

    // The week window adds a per-day average under the headline.
    await user.click(within(card).getByRole('tab', { name: 'Week' }));
    expect(within(card).getByText('tokens this week')).toBeTruthy();
    expect(within(card).getByText(/avg .* \/ day/)).toBeTruthy();

    await user.click(within(card).getByRole('tab', { name: 'Month' }));
    expect(within(card).getByText('tokens this month')).toBeTruthy();
    expect(within(headlineFor(card, 'tokens this month')).getByText('30.0K')).toBeTruthy();

    // The 14-day token sparkline and its footer read from the same series.
    // Cost keeps to the compare column here; its own sparkline is widget-only.
    expect(within(card).getAllByRole('img', { name: 'Time series chart' })).toHaveLength(1);
    expect(within(card).getByText('14-day trend')).toBeTruthy();
    expect(within(card).getByText('7d 9.3K · $0.90')).toBeTruthy();

    // Gemini CLI connects itself, so its only actions are [dashboard, desktop]:
    // no plan-limits toggle without subscription windows, no key, no remove.
    expect(within(card).getAllByRole('button')).toHaveLength(2);

    // The combined card above counts Gemini CLI in its per-agent breakdown,
    // painted with the same accent as its own card.
    const agentRow = within(allAgentsCard()).getByText('Gemini CLI').closest('div.grid');
    expect(
      ((agentRow as HTMLElement).querySelector('.bar-shine') as HTMLElement).style.backgroundColor,
    ).toBe(gemini);
  });

  it('keeps the Gemini CLI card at an honest zero while the CLI logs no token counts', async () => {
    const zeros = new Array<number>(14).fill(0);
    renderPage({
      'settings.get': {},
      'usage.list': [usage({ providerId: 'gemini-cli', series: zeros, costSeries: zeros })],
    });

    await screen.findByText('Gemini CLI');
    const card = cardFor('Gemini CLI');
    await waitFor(() => expect(within(card).getByText('tokens today')).toBeTruthy());

    // Tokens headline with no cost: nothing is priced, so no dollar figure is shown.
    expect(within(headlineFor(card, 'tokens today')).getByText('0')).toBeTruthy();
    expect(within(card).queryByText(/\$\d/)).toBeNull();
    expect(within(card).queryByText('Cost')).toBeNull();
    // No quota bar either: the CLI reports no rate-limit window to draw.
    expect(within(card).queryByText(/resets in/)).toBeNull();
    // The flat trend still draws, so the empty state reads as "no data yet".
    expect(within(card).getByRole('img', { name: 'Time series chart' })).toBeTruthy();
    expect(within(card).getByText('14-day trend')).toBeTruthy();
    expect(within(card).getByText('7d 0')).toBeTruthy();
  });

  it('adds a provider card to the dashboard and takes it off again', async () => {
    const { user } = renderPage({ 'settings.get': {}, 'usage.list': [claudeUsage] });

    await screen.findByText('Claude Code');
    const card = cardFor('Claude Code');
    const buttons = within(card).getAllByRole('button');
    // [reset alerts, threshold alerts, dashboard, desktop]: no subscription, nothing removable.
    const dashboardButton = buttons[buttons.length - 2];
    await user.click(dashboardButton);

    await waitFor(() =>
      expect(useDashboardLayoutStore.getState().usageCards).toContain('claude-code'),
    );
    expect(toast.success).toHaveBeenCalledWith('Claude Code added to your dashboard.');

    await user.click(within(cardFor('Claude Code')).getAllByRole('button').at(-2)!);

    await waitFor(() =>
      expect(useDashboardLayoutStore.getState().usageCards).not.toContain('claude-code'),
    );
    expect(confirm.confirmDialog).toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith('Claude Code removed from your dashboard.');
  });
});

describe('UsagePage project weekday chart', () => {
  it('sits between the combined card and the provider cards', async () => {
    renderPage({ 'settings.get': {}, 'usage.list': [claudeUsage, codexUsage] });

    const heading = await screen.findByRole('heading', { name: 'Projects by weekday' });
    const combined = allAgentsCard();
    expect(
      combined.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      heading.compareDocumentPosition(cardFor('Claude Code')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('draws from the same usage list as the tiles, so the two agree on the projects', async () => {
    const withSplit = usage({
      providerId: 'claude-code',
      today: period(1_000, 0.5),
      last7d: period(7_000, 3),
      last30d: period(30_000, 12),
      projectDaily: splitOf([
        projectRow({ key: 'project:p1', name: 'Runova', tokens: [0, 0, 0, 0, 0, 0, 1000] }),
      ]),
    });
    renderPage({ 'settings.get': {}, 'usage.list': [withSplit] });

    expect(await screen.findByRole('button', { name: /Runova/ })).toBeTruthy();
    await waitFor(() => expect(tileValue('Tokens today')).toBe('1.0K'));
  });

  it('shows its own loading state, not an overlay, while the list is pending', async () => {
    renderPage({ 'settings.get': {}, 'usage.list': () => new Promise(() => undefined) });

    expect(await screen.findByRole('status', { name: 'Loading project usage' })).toBeTruthy();
  });

  it('shows a generic message when the list fails, and leaves the raw error to the cards', async () => {
    renderPage({
      'settings.get': {},
      'usage.list': () => Promise.reject(new Error('usage scan crashed')),
    });

    expect(await screen.findByText('Project usage could not be loaded.')).toBeTruthy();
    // The six provider cards still report the raw error on their own, and nothing else does.
    expect(await screen.findAllByText('usage scan crashed')).toHaveLength(6);
  });
});
