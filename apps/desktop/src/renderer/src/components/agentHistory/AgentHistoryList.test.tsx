// @vitest-environment jsdom
import type { AgentHistorySession } from '@runova/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import {
  BackgroundToggle,
  HistoryDayGroups,
  HistoryRow,
  HistorySkeleton,
  HistoryToolbar,
} from './AgentHistoryList';

function session(overrides: Partial<AgentHistorySession> = {}): AgentHistorySession {
  return {
    provider: 'claude-code',
    id: 'aaaaaaaa-0001',
    title: null,
    firstPrompt: null,
    lastPrompt: null,
    cwd: '/home/ubuntu/app',
    gitBranch: null,
    model: null,
    effort: null,
    startedAt: null,
    updatedAt: Date.now() - 60_000,
    sizeBytes: 100,
    background: false,
    ...overrides,
  };
}

function renderUi(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

beforeEach(() => {
  installRunovaBridge({ platform: 'linux' });
});

afterEach(cleanup);

describe('HistoryRow', () => {
  it('heads the row with the title, then the first prompt, then a fallback', () => {
    const { rerender } = renderUi(
      <HistoryRow session={session({ title: 'Named', firstPrompt: 'asked' })} onResume={vi.fn()} />,
    );
    expect(screen.getByText('Named')).toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <HistoryRow session={session({ firstPrompt: 'asked first' })} onResume={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByText('asked first')).toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <HistoryRow session={session()} onResume={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Untitled conversation')).toBeInTheDocument();
  });

  it('shows the branch and the model the run used', () => {
    renderUi(
      <HistoryRow
        session={session({ gitBranch: 'feature/x', model: 'gpt-5-codex', effort: 'high' })}
        onResume={vi.fn()}
      />,
    );
    expect(screen.getByText('feature/x')).toBeInTheDocument();
    expect(screen.getByText(/GPT-5-codex · high effort/)).toBeInTheDocument();
  });

  it('names the model an OpenCode session ran on', () => {
    renderUi(
      <HistoryRow
        session={session({
          provider: 'opencode',
          model: 'muse-spark-1.3-contributor-free',
          updatedAt: Date.now(),
        })}
        onResume={vi.fn()}
      />,
    );
    expect(screen.getByText(/Muse Spark 1\.3 Contributor Free/)).toBeInTheDocument();
  });

  it('shows no model line when the CLI stores none, like FreeBuff', () => {
    renderUi(
      <HistoryRow
        session={session({
          provider: 'freebuff-cli',
          title: 'FreeBuff ask',
          model: null,
          effort: null,
          updatedAt: Date.now() - 60_000,
        })}
        onResume={vi.fn()}
      />,
    );
    expect(screen.getByText('FreeBuff ask')).toBeInTheDocument();
    // The meta line is just the age: no model, no effort separator.
    expect(screen.getByText(/ago/)).toBeInTheDocument();
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });

  it('marks a conversation already open in a tab and drops the resume button', () => {
    renderUi(<HistoryRow session={session()} openTabId="tab-1" onResume={vi.fn()} />);
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume in a new tab' })).not.toBeInTheDocument();
  });

  it('resumes from a click on the row or on the play button', () => {
    const onResume = vi.fn();
    const s = session({ title: 'Resume me' });
    renderUi(<HistoryRow session={s} onResume={onResume} />);

    fireEvent.click(screen.getByText('Resume me'));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenLastCalledWith(s);

    fireEvent.click(screen.getByRole('button', { name: 'Resume in a new tab' }));
    expect(onResume).toHaveBeenCalledTimes(2);
  });

  it('with a reason to hold off, disables play and ignores clicks on the row', () => {
    const onResume = vi.fn();
    renderUi(
      <HistoryRow
        session={session({ title: 'Remote one' })}
        onResume={onResume}
        resumeDisabledReason="Connect to the server first"
      />,
    );
    const play = screen.getByRole('button', { name: 'Resume in a new tab' });
    expect(play).toBeDisabled();
    fireEvent.click(play);
    fireEvent.click(screen.getByText('Remote one'));
    expect(onResume).not.toHaveBeenCalled();
    expect(screen.getByText('Remote one').closest('button')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('copies the conversation id', () => {
    renderUi(<HistoryRow session={session({ id: 'copy-me-123' })} onResume={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy conversation id' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('copy-me-123');
  });
});

describe('HistoryRow usage menu', () => {
  const tokens = {
    input: 1_200,
    output: 3_400,
    cacheRead: 2_500_000,
    cacheWrite: 80_000,
    total: 2_584_600,
  };

  function renderRow(
    answer: unknown,
    overrides: Partial<AgentHistorySession> = {},
    showUsage = true,
  ) {
    return renderWithProviders(
      <HistoryRow
        session={session({ title: 'Costly one', ...overrides })}
        onResume={vi.fn()}
        showUsage={showUsage}
      />,
      { bridge: { 'agents.sessionUsage': answer } },
    );
  }

  const opus = { model: 'claude-opus-5-5', tokens, costUsd: 3.456 };

  /** An answer for a usable log; each test says only what it changes. */
  function usage(overrides: Record<string, unknown> = {}) {
    return {
      status: 'ok',
      tokens,
      costUsd: 3.456,
      costPartial: false,
      models: [opus],
      ...overrides,
    };
  }

  it('shows the tokens used and the estimated cost on a right-click', async () => {
    const { bridge } = renderRow(usage());
    // The details are fetched when the menu opens, not for every row in the list.
    expect(() => bridge.$fn('agents.sessionUsage')).toThrow();

    fireEvent.contextMenu(screen.getByText('Costly one'));

    expect(await screen.findByText('Token usage')).toBeInTheDocument();
    // The headline numbers, the total also spelled out in full.
    expect(await screen.findByText('2.58M')).toBeInTheDocument();
    expect(screen.getByText('2,584,600')).toBeInTheDocument();
    expect(screen.getByText('$3.46')).toBeInTheDocument();
    // The split, each kind with its share of the total.
    for (const [label, value, percent] of [
      ['Input', '1.2K', '<1%'],
      ['Output', '3.4K', '<1%'],
      ['Cache read', '2.50M', '97%'],
      ['Cache write', '80.0K', '3%'],
    ]) {
      const row = screen.getByText(label).parentElement as HTMLElement;
      expect(row).toHaveTextContent(`${label}${value}${percent}`);
    }
    expect(bridge.$fn('agents.sessionUsage')).toHaveBeenCalledWith('claude-code', 'aaaaaaaa-0001');
  });

  it('describes the split for screen readers and draws only the kinds that were used', async () => {
    const onlyCache = { input: 0, output: 0, cacheRead: 900, cacheWrite: 100, total: 1_000 };
    renderRow(usage({ tokens: onlyCache }));
    fireEvent.contextMenu(screen.getByText('Costly one'));

    const bar = await screen.findByRole('img', { name: /Token split/ });
    expect(bar).toHaveAccessibleName(
      'Token split: Input 0%, Output 0%, Cache read 90%, Cache write 10%',
    );
    expect(bar.children).toHaveLength(2);
  });

  it('opens from the hover buttons too, since the whole row is the trigger', async () => {
    renderRow(usage());
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Copy conversation id' }));
    expect(await screen.findByText('Token usage')).toBeInTheDocument();
  });

  it('breaks a conversation that switched models down per model', async () => {
    renderRow(
      usage({
        costUsd: 4,
        costPartial: true,
        models: [
          opus,
          { model: 'claude-sonnet-5-5', tokens: { ...tokens, total: 500 }, costUsd: 0.5 },
          { model: 'a-model-nobody-has-priced', tokens: { ...tokens, total: 100 }, costUsd: null },
        ],
      }),
    );
    fireEvent.contextMenu(screen.getByText('Costly one'));

    expect(await screen.findByText('Models')).toBeInTheDocument();
    expect(screen.getByText('Opus 5.5').parentElement).toHaveTextContent('Opus 5.52.58M$3.46');
    expect(screen.getByText('Sonnet 5.5').parentElement).toHaveTextContent('500$0.50');
    expect(screen.getByText('Unpriced')).toBeInTheDocument();
  });

  it('folds a long model list into a count', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      model: `claude-opus-5-${i}`,
      tokens: { ...tokens, total: 1000 - i },
      costUsd: 1,
    }));
    renderRow(usage({ models: many }));
    fireEvent.contextMenu(screen.getByText('Costly one'));
    expect(await screen.findByText('and 2 more')).toBeInTheDocument();
  });

  it('names no model list when the run used one model', async () => {
    renderRow(usage());
    fireEvent.contextMenu(screen.getByText('Costly one'));
    await screen.findByText('Token usage');
    expect(screen.queryByText('Models')).not.toBeInTheDocument();
  });

  it('marks a cost that only covers the models with a price', async () => {
    renderRow(usage({ costUsd: 1, costPartial: true }));
    fireEvent.contextMenu(screen.getByText('Costly one'));
    expect(await screen.findByText('$1.00+')).toBeInTheDocument();
    expect(screen.getByText(/Some models have no known price/)).toBeInTheDocument();
  });

  it('says so when no model in the run has a price', async () => {
    renderRow(usage({ costUsd: null, models: [{ ...opus, costUsd: null }] }));
    fireEvent.contextMenu(screen.getByText('Costly one'));
    expect(await screen.findByText('Unpriced')).toBeInTheDocument();
    expect(screen.getByText('No price is known for the model this ran on.')).toBeInTheDocument();
  });

  it('shows a conversation that used nothing as zero, with no bar and no price worry', async () => {
    const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    renderRow(usage({ tokens: empty, costUsd: null, models: [] }));
    fireEvent.contextMenu(screen.getByText('Costly one'));
    expect(await screen.findByText('$0.00')).toBeInTheDocument();
    expect(screen.getByText('No tokens used yet.')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Token split/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/No price is known/)).not.toBeInTheDocument();
  });

  it('names an agent that keeps no token counts', async () => {
    renderRow({ status: 'unsupported' }, { provider: 'gemini-cli' });
    fireEvent.contextMenu(screen.getByText('Costly one'));
    expect(await screen.findByText('Gemini does not record token usage.')).toBeInTheDocument();
  });

  it('says when the conversation log could not be read', async () => {
    renderRow({ status: 'unavailable' });
    fireEvent.contextMenu(screen.getByText('Costly one'));
    expect(
      await screen.findByText('The log for this conversation could not be read.'),
    ).toBeInTheDocument();
  });

  it('offers no menu on a row that did not ask for one', () => {
    renderRow({ status: 'unavailable' }, {}, false);
    fireEvent.contextMenu(screen.getByText('Costly one'));
    expect(screen.queryByText('Token usage')).not.toBeInTheDocument();
  });
});

describe('HistoryToolbar', () => {
  function renderToolbar(
    providers: AgentHistorySession['provider'][],
    counts?: Map<AgentHistorySession['provider'], number>,
  ) {
    const handlers = { onQueryChange: vi.fn(), onProviderChange: vi.fn() };
    renderUi(
      <HistoryToolbar
        query=""
        provider="all"
        providers={new Set(providers)}
        counts={counts}
        onQueryChange={handlers.onQueryChange}
        onProviderChange={handlers.onProviderChange}
      />,
    );
    return handlers;
  }

  async function openMenu() {
    await userEvent.setup().click(screen.getByRole('button', { name: 'Filter by agent' }));
    return screen.findAllByRole('menuitemradio');
  }

  it('offers the agent filter only when there is more than one agent', () => {
    renderToolbar(['claude-code']);
    expect(screen.queryByRole('button', { name: 'Filter by agent' })).not.toBeInTheDocument();
    cleanup();

    renderToolbar(['claude-code', 'codex']);
    expect(screen.getByRole('button', { name: 'Filter by agent' })).toHaveTextContent('All agents');
  });

  it('picks an agent from the menu', async () => {
    const handlers = renderToolbar(
      ['claude-code', 'codex'],
      new Map([
        ['claude-code', 1],
        ['codex', 1],
      ]),
    );
    const items = await openMenu();
    expect(items.map((r) => r.textContent)).toEqual(['All agents2', 'Claude1', 'Codex1']);
    await userEvent.setup().click(screen.getByRole('menuitemradio', { name: 'Codex1' }));
    expect(handlers.onProviderChange).toHaveBeenCalledWith('codex');
  });

  it('reports typing in the search box', () => {
    const handlers = renderToolbar(['claude-code']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search conversations' }), {
      target: { value: 'login' },
    });
    expect(handlers.onQueryChange).toHaveBeenCalledWith('login');
  });

  it('lists every provider present with counts, busiest first', async () => {
    // Regression test: the filter must grow with new history providers.
    renderToolbar(
      ['claude-code', 'gemini-cli', 'cursor-cli', 'codex', 'opencode', 'freebuff-cli'],
      new Map([
        ['claude-code', 1],
        ['gemini-cli', 5],
        ['cursor-cli', 2],
        ['codex', 1],
        ['opencode', 3],
        ['freebuff-cli', 4],
      ]),
    );
    const items = await openMenu();
    expect(items.map((r) => r.textContent)).toEqual([
      'All agents16',
      'Gemini5',
      'FreeBuff4',
      'OpenCode3',
      'Cursor2',
      'Claude1',
      'Codex1',
    ]);
  });
});

describe('HistoryDayGroups', () => {
  it('groups rows under day headers and passes open tabs and reasons through', () => {
    const today = session({ id: 'today-0001', title: 'From today', updatedAt: Date.now() });
    const old = session({
      id: 'older-0001',
      title: 'From long ago',
      updatedAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
    });
    const onResume = vi.fn();
    renderUi(
      <HistoryDayGroups
        sessions={[today, old]}
        openIds={new Map([['today-0001', 'tab-9']])}
        onResume={onResume}
        resumeDisabledReason={(s) => (s.id === 'older-0001' ? 'Offline' : null)}
      />,
    );
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Older')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume in a new tab' })).toBeDisabled();

    fireEvent.click(screen.getByText('From today'));
    expect(onResume).toHaveBeenCalledWith(today);
    fireEvent.click(screen.getByText('From long ago'));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('hands the usage menu to every row, or to none', async () => {
    const sessions = [
      session({ id: 'one-0001', title: 'First' }),
      session({ id: 'two-0001', title: 'Second' }),
    ];
    const answer = {
      status: 'ok',
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      costUsd: 0.01,
      costPartial: false,
      models: [],
    };
    const { bridge, unmount } = renderWithProviders(
      <HistoryDayGroups sessions={sessions} openIds={new Map()} onResume={vi.fn()} showUsage />,
      { bridge: { 'agents.sessionUsage': answer } },
    );
    // The second row, so it is not just the first one that got the menu.
    fireEvent.contextMenu(screen.getByText('Second'));
    expect(await screen.findByText('Token usage')).toBeInTheDocument();
    expect(bridge.$fn('agents.sessionUsage')).toHaveBeenCalledTimes(1);
    expect(bridge.$fn('agents.sessionUsage')).toHaveBeenCalledWith('claude-code', 'two-0001');
    unmount();

    renderWithProviders(
      <HistoryDayGroups sessions={sessions} openIds={new Map()} onResume={vi.fn()} />,
    );
    fireEvent.contextMenu(screen.getByText('First'));
    expect(screen.queryByText('Token usage')).not.toBeInTheDocument();
  });
});

describe('BackgroundToggle', () => {
  it('names how many tool runs are hidden, and hides itself when there are none', () => {
    const onToggle = vi.fn();
    const { rerender, container } = renderUi(
      <BackgroundToggle count={3} shown={false} onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 runs started by tools' }));
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(
      <TooltipProvider>
        <BackgroundToggle count={1} shown={false} onToggle={onToggle} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Show 1 run started by tools' })).toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <BackgroundToggle count={1} shown onToggle={onToggle} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Hide runs started by tools' })).toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <BackgroundToggle count={0} shown={false} onToggle={onToggle} />
      </TooltipProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('HistorySkeleton', () => {
  it('draws the requested number of placeholder rows', () => {
    const { container } = renderUi(<HistorySkeleton rows={3} />);
    expect(container.querySelectorAll('.shimmer')).toHaveLength(9);
  });
});
