// @vitest-environment jsdom
import { defaultGrammarSettings } from '@runova/core';
import type { GrammarIssue } from '@shared/grammar';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { GrammarCheckState } from '@/hooks/useGrammarCheck';
import { GrammarPanel } from './GrammarPanel';

/**
 * The writing check's counter and its popover. Nothing else renders it in a test, and it sits
 * inside the Markdown editor on the project page, so a crash here takes that page down.
 */

const issue: GrammarIssue = {
  offset: 4,
  length: 4,
  text: 'teh',
  message: 'Possible spelling mistake found.',
  shortMessage: 'Spelling mistake',
  kind: 'spelling',
  ruleId: 'MORFOLOGIK_RULE_EN_US',
  categoryName: 'Possible Typo',
  replacements: ['the', 'ten'],
};

function stateWith(overrides: Partial<GrammarCheckState> = {}): GrammarCheckState {
  return {
    issues: [issue],
    checking: false,
    error: null,
    language: 'English (US)',
    truncatedAt: null,
    active: true,
    settings: defaultGrammarSettings(),
    recheck: vi.fn(async () => []),
    dismiss: vi.fn(),
    ...overrides,
  };
}

function renderPanel(state: GrammarCheckState, value = 'Fix teh typo') {
  return render(
    <TooltipProvider>
      <GrammarPanel field={null} value={value} state={state} />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe('GrammarPanel', () => {
  it('renders nothing while checking is off', () => {
    renderPanel(stateWith({ active: false }));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens a popover listing each issue with its suggestions', () => {
    const state = stateWith();
    renderPanel(state);
    fireEvent.click(screen.getByRole('button', { name: /1 issue/ }));

    const panel = screen.getByRole('dialog', { name: 'Writing check' });
    expect(panel).toHaveTextContent('Spelling mistake');
    expect(panel).toHaveTextContent('English (US)');
    expect(screen.getByRole('button', { name: 'the' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fix 1 mistake' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ignore this issue' }));
    expect(state.dismiss).toHaveBeenCalledWith(issue);
  });

  it('says when the check failed', () => {
    renderPanel(stateWith({ issues: [], error: 'LanguageTool is not reachable.' }));
    fireEvent.click(screen.getByRole('button', { name: /Check failed/ }));
    expect(screen.getByText('LanguageTool is not reachable.')).toBeInTheDocument();
  });

  it('says when there is nothing to fix', () => {
    renderPanel(stateWith({ issues: [] }));
    fireEvent.click(screen.getByRole('button', { name: /No issues/ }));
    expect(screen.getByText(/Nothing to fix here/)).toBeInTheDocument();
  });
});
