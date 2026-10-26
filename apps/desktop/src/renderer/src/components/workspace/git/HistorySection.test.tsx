// @vitest-environment jsdom
import type { AgentHistorySession, Project } from '@runova/core';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { HistorySection } from './HistorySection';

/**
 * The workspace's Agent sessions list is the one place a conversation's own log is on this
 * machine, so it is the list whose rows open the token usage menu.
 */

const project = { id: 'p1', name: 'App', folderPath: '/work/app' } as unknown as Project;

function session(overrides: Partial<AgentHistorySession>): AgentHistorySession {
  return {
    provider: 'claude-code',
    id: 'conv-1',
    title: 'Fix the login flow',
    firstPrompt: null,
    lastPrompt: null,
    cwd: '/work/app',
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

const usage = {
  status: 'ok',
  tokens: {
    input: 1_200,
    output: 3_400,
    cacheRead: 2_500_000,
    cacheWrite: 80_000,
    total: 2_584_600,
  },
  costUsd: 0.97,
  costPartial: false,
  models: [],
};

afterEach(cleanup);

describe('HistorySection token usage menu', () => {
  it('opens the usage menu on a right-click of a conversation', async () => {
    const { bridge } = renderWithProviders(<HistorySection project={project} />, {
      bridge: { 'agents.history': [session({})], 'agents.sessionUsage': usage },
    });

    fireEvent.contextMenu(await screen.findByText('Fix the login flow'));

    expect(await screen.findByText('Token usage')).toBeInTheDocument();
    expect(await screen.findByText('2.58M')).toBeInTheDocument();
    expect(screen.getByText('$0.97')).toBeInTheDocument();
    expect(bridge.$fn('agents.sessionUsage')).toHaveBeenCalledWith('claude-code', 'conv-1');
  });

  it('asks only for the conversation that was right-clicked, by its own agent', async () => {
    const { bridge } = renderWithProviders(<HistorySection project={project} />, {
      bridge: {
        'agents.history': [
          session({ id: 'conv-1', title: 'First one' }),
          session({ id: 'conv-2', title: 'Second one', provider: 'codex' }),
        ],
        'agents.sessionUsage': usage,
      },
    });

    fireEvent.contextMenu(await screen.findByText('Second one'));
    await screen.findByText('2.58M');

    const asked = bridge.$fn('agents.sessionUsage');
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith('codex', 'conv-2');
  });

  it('shows the plain list, with no menu, until a row is right-clicked', async () => {
    const { bridge } = renderWithProviders(<HistorySection project={project} />, {
      bridge: { 'agents.history': [session({})], 'agents.sessionUsage': usage },
    });

    await screen.findByText('Fix the login flow');

    expect(screen.queryByText('Token usage')).not.toBeInTheDocument();
    expect(() => bridge.$fn('agents.sessionUsage')).toThrow();
  });
});
