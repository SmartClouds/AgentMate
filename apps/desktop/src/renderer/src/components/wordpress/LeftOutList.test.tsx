import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WpItemRef } from '@runova/core';
import type { DeployWordPressLeftOut } from '@shared/deployWordPressTypes';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AGENT_HEADING, isAgentLeftOut, LeftOutList } from './LeftOutList';

/**
 * Every deploy review says what stays on this computer. The shared fixture is a theme folder the
 * way an agent leaves it; whatever reason the walker gives for each hard-denied path, the review
 * has to show it, and agent files go under their own heading that is never folded away.
 */

interface Fixture {
  item: WpItemRef;
  files: { path: string; expect: 'synced' | 'hardDenied' | 'ignoredUntracked' }[];
}

const fixture = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../../../../packages/core/src/deploy/wordpress/vectors/agent-files.json',
    ),
    'utf-8',
  ),
) as Fixture;

const hardDenied = fixture.files.filter((file) => file.expect === 'hardDenied');
const ignored = fixture.files.filter((file) => file.expect === 'ignoredUntracked');

/** Agent folders and instruction files, as opposed to version control, secrets and clutter. */
const AGENT_PATHS = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/skills/x/SKILL.md',
  '.runova/hooks/notify.sh',
  '.runova/installed-skills.json',
  '.agents/skills/y/SKILL.md',
  '.codex/config.toml',
  '.cursor/rules/r.mdc',
  '.gemini/settings.json',
  '.opencode/agents/a.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.mcp.json',
];

function agentList(): HTMLElement {
  return screen.getByRole('list', { name: AGENT_HEADING });
}

describe('LeftOutList with the shared agent-files fixture', () => {
  it('shows every hard-denied path when the walker reports them all as hardDenied', () => {
    const entries: DeployWordPressLeftOut[] = [
      ...hardDenied.map((file) => ({
        item: fixture.item,
        path: file.path,
        reason: 'hardDenied' as const,
      })),
      ...ignored.map((file) => ({
        item: fixture.item,
        path: file.path,
        reason: 'ignored' as const,
      })),
    ];
    render(<LeftOutList entries={entries} direction="deploy" />);

    expect(screen.getByText(/never leave this\s+computer/)).toBeTruthy();
    for (const file of hardDenied) {
      expect(screen.getByText(file.path)).toBeTruthy();
    }
    for (const path of AGENT_PATHS) {
      expect(within(agentList()).getByText(path)).toBeTruthy();
    }
    // Version control, secrets and clutter are left out too, under their own reason.
    const denied = screen.getByRole('list', { name: /Never sent: version control/ });
    for (const path of [
      '.git/HEAD',
      '.github/workflows/ci.yml',
      '.env',
      '.env.local',
      'inc/.DS_Store',
    ]) {
      expect(within(denied).getByText(path)).toBeTruthy();
    }
    const ignoredList = screen.getByRole('list', { name: /ignore rule/ });
    for (const file of ignored) {
      expect(within(ignoredList).getByText(file.path)).toBeTruthy();
    }
  });

  it('puts the agent files under the agent heading when the walker says agentFiles', () => {
    const entries: DeployWordPressLeftOut[] = hardDenied.map((file) => ({
      item: fixture.item,
      path: file.path,
      reason: AGENT_PATHS.includes(file.path) ? ('agentFiles' as const) : ('hardDenied' as const),
    }));
    render(<LeftOutList entries={entries} direction="deploy" />);

    for (const path of AGENT_PATHS) {
      expect(within(agentList()).getByText(path)).toBeTruthy();
    }
    expect(within(agentList()).queryByText('.git/HEAD')).toBeNull();
    for (const file of hardDenied) {
      expect(screen.getByText(file.path)).toBeTruthy();
    }
  });

  it('shows the same paths when the site refused them as pathRejected', () => {
    const entries: DeployWordPressLeftOut[] = hardDenied.map((file) => ({
      item: fixture.item,
      path: file.path,
      reason: 'pathRejected' as const,
    }));
    render(<LeftOutList entries={entries} direction="deploy" />);

    for (const path of AGENT_PATHS) {
      expect(within(agentList()).getByText(path)).toBeTruthy();
    }
    const rejected = screen.getByRole('list', { name: /can't safely hold/ });
    expect(within(rejected).getByText('.git/HEAD')).toBeTruthy();
  });

  it('never folds the agent files away, however many there are', () => {
    const entries: DeployWordPressLeftOut[] = Array.from({ length: 80 }, (_, index) => ({
      item: fixture.item,
      path: `.claude/skills/s${index}/SKILL.md`,
      reason: 'agentFiles' as const,
    }));
    render(<LeftOutList entries={entries} direction="deploy" />);

    expect(within(agentList()).getAllByRole('listitem')).toHaveLength(80);
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
  });

  it('says agent files stay here even when nothing at all was left out', () => {
    render(<LeftOutList entries={[]} direction="pull" />);
    expect(screen.getByText(/never leave this\s+computer/)).toBeTruthy();
    expect(screen.getByText('Nothing else is left out.')).toBeTruthy();
  });

  it('tells agent paths from the rest of the deny list', () => {
    const item = fixture.item;
    expect(isAgentLeftOut({ item, path: 'inc/.claude/x.json', reason: 'hardDenied' })).toBe(true);
    expect(isAgentLeftOut({ item, path: '.aider.conf.yml', reason: 'hardDenied' })).toBe(true);
    expect(isAgentLeftOut({ item, path: '.git/HEAD', reason: 'hardDenied' })).toBe(false);
    expect(isAgentLeftOut({ item, path: '.claude/x', reason: 'ignored' })).toBe(false);
    expect(isAgentLeftOut({ item, path: 'anything', reason: 'agentFiles' })).toBe(true);
  });
});
