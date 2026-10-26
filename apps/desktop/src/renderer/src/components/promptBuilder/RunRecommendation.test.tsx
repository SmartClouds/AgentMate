// @vitest-environment jsdom
import type { RunAssessment } from '@runova/core';
import { recommendationFromAssessment, runProfileForTargetAI } from '@runova/core';
import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  renderHookWithProviders,
  renderWithProviders,
} from '../../../../test/renderer/renderWithProviders';
import {
  RunRecommendationChip,
  RunRecommendationPanel,
  type RunRecommendationState,
  shouldSizeOnOpen,
  useRunRecommendation,
} from './RunRecommendation';

/**
 * The Recommended run chip sizes a prompt when it is opened, but only while the Build Prompt
 * sizing switch is off (`sizeOnOpen`). These tests pin down when that happens, what the chip and
 * its panel say about it, and that a translation is sized without a prompt type.
 */

const TARGET = 'Claude Code';
const profile = runProfileForTargetAI(TARGET);
const assessment: RunAssessment = {
  score: 35,
  complexity: 'light',
  signals: [],
  summary: 'A short, clear request.',
  modelId: profile.models[0]?.id ?? '',
  effort: undefined,
};
const recommendation = recommendationFromAssessment(TARGET, assessment);

/** A state the chip can render, with the analyze spy the assertions read. */
function stateWith(overrides: Partial<RunRecommendationState> = {}): RunRecommendationState {
  return {
    status: 'idle',
    targetAI: TARGET,
    recommendation: null,
    choice: null,
    isCustom: false,
    isStale: false,
    error: null,
    cliName: null,
    canAnalyze: true,
    analyze: vi.fn(),
    cancel: vi.fn(),
    selectModel: vi.fn(),
    selectEffort: vi.fn(),
    reset: vi.fn(),
    args: [],
    ...overrides,
  };
}

/** The fields of a state that holds a sizing for the current prompt. */
const sized = { recommendation, choice: recommendation.recommended };

describe('shouldSizeOnOpen', () => {
  it.each([
    ['a prompt that has never been sized', stateWith(), true],
    ['a prompt whose last sizing failed', stateWith({ status: 'error', error: 'no CLI' }), true],
    [
      'a sizing made for an older prompt or target',
      stateWith({ status: 'ready', ...sized, isStale: true }),
      true,
    ],
    ['a sizing that is still running', stateWith({ status: 'analyzing' }), false],
    ['a current sizing', stateWith({ status: 'ready', ...sized }), false],
    [
      'a current sizing whose refresh failed',
      stateWith({ status: 'error', error: 'no CLI', ...sized }),
      false,
    ],
    ['no prompt to size yet', stateWith({ canAnalyze: false }), false],
  ])('for %s', (_label, state, expected) => {
    expect(shouldSizeOnOpen(state)).toBe(expected);
  });
});

describe('Recommended run chip opened with the switch off', () => {
  it('starts sizing the first time it opens', async () => {
    const state = stateWith();
    const { user } = renderWithProviders(<RunRecommendationChip state={state} sizeOnOpen />);

    await user.click(screen.getByRole('button'));

    expect(state.analyze).toHaveBeenCalledTimes(1);
  });

  it('starts sizing again when the prompt changed since the last result', async () => {
    const state = stateWith({ status: 'ready', ...sized, isStale: true });
    const { user } = renderWithProviders(<RunRecommendationChip state={state} sizeOnOpen />);

    await user.click(screen.getByRole('button'));

    expect(state.analyze).toHaveBeenCalledTimes(1);
  });

  it('tries again when the last sizing failed', async () => {
    const state = stateWith({ status: 'error', error: 'no CLI' });
    const { user } = renderWithProviders(<RunRecommendationChip state={state} sizeOnOpen />);

    await user.click(screen.getByRole('button'));

    expect(state.analyze).toHaveBeenCalledTimes(1);
  });

  it('keeps a current result and does not size it again', async () => {
    const state = stateWith({ status: 'ready', ...sized });
    const { user } = renderWithProviders(<RunRecommendationChip state={state} sizeOnOpen />);

    await user.click(screen.getByRole('button'));

    expect(state.analyze).not.toHaveBeenCalled();
  });

  it('does not start a second sizing while one is running', async () => {
    const state = stateWith({ status: 'analyzing' });
    const { user } = renderWithProviders(<RunRecommendationChip state={state} sizeOnOpen />);

    await user.click(screen.getByRole('button'));

    expect(state.analyze).not.toHaveBeenCalled();
  });

  it('does not size when there is no prompt yet', async () => {
    const state = stateWith({ canAnalyze: false });
    const { user } = renderWithProviders(<RunRecommendationChip state={state} sizeOnOpen />);

    await user.click(screen.getByRole('button'));

    expect(state.analyze).not.toHaveBeenCalled();
    expect(screen.getByText(/Then your default AI CLI sizes it when you open this/)).toBeVisible();
  });

  it('says on hover that opening the chip is what sizes the prompt', async () => {
    const state = stateWith({ canAnalyze: false });
    const { user } = renderWithProviders(<RunRecommendationChip state={state} sizeOnOpen />);

    await user.hover(screen.getByRole('button'));

    expect(
      await screen.findByText('Generate or translate a prompt, then open this to size it'),
    ).toBeInTheDocument();
  });
});

describe('Recommended run chip with the switch on (the default)', () => {
  it('leaves an unsized prompt for the user to size from the panel', async () => {
    const state = stateWith();
    const { user } = renderWithProviders(<RunRecommendationChip state={state} />);

    await user.click(screen.getByRole('button'));

    expect(state.analyze).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Size this prompt/ })).toBeInTheDocument();
  });

  it('keeps the original empty-state copy when there is no prompt yet', async () => {
    const state = stateWith({ canAnalyze: false });
    const { user } = renderWithProviders(<RunRecommendationChip state={state} />);

    await user.click(screen.getByRole('button'));

    expect(screen.getByText(/then sizes it and suggests a model and effort/)).toBeVisible();
    expect(state.analyze).not.toHaveBeenCalled();
  });
});

describe('useRunRecommendation sizing a translation', () => {
  it('sizes a translation without a prompt type', () => {
    const assessRun = vi.fn(async (_input: { prompt: string; promptType?: string }) => ({
      ok: false,
      error: 'no CLI',
    }));
    const { result } = renderHookWithProviders(
      () =>
        useRunRecommendation({
          jobKey: 'project:p1',
          generated: 'Translated request',
          promptType: 'Full Stack',
          targetAI: TARGET,
          isTranslation: true,
        }),
      { bridge: { 'ai.assessRun': assessRun } },
    );

    act(() => result.current.analyze());

    expect(assessRun).toHaveBeenCalledTimes(1);
    const input = assessRun.mock.calls[0]?.[0];
    expect(input?.prompt).toBe('Translated request');
    expect(input?.promptType).toBeUndefined();
  });

  it('sizes a generated prompt with its prompt type', () => {
    const assessRun = vi.fn(async (_input: { prompt: string; promptType?: string }) => ({
      ok: false,
      error: 'no CLI',
    }));
    const { result } = renderHookWithProviders(
      () =>
        useRunRecommendation({
          jobKey: 'project:p1',
          generated: 'Build the login form.',
          promptType: 'Frontend',
          targetAI: TARGET,
        }),
      { bridge: { 'ai.assessRun': assessRun } },
    );

    act(() => result.current.analyze());

    expect(assessRun.mock.calls[0]?.[0].promptType).toBe('Frontend');
  });

  it('lets a single analysis override what the hook was told about the text', () => {
    const assessRun = vi.fn(async (_input: { prompt: string; promptType?: string }) => ({
      ok: false,
      error: 'no CLI',
    }));
    const { result } = renderHookWithProviders(
      () =>
        useRunRecommendation({
          jobKey: 'project:p1',
          generated: 'Build the login form.',
          promptType: 'Frontend',
          targetAI: TARGET,
          isTranslation: true,
        }),
      { bridge: { 'ai.assessRun': assessRun } },
    );

    act(() => result.current.analyze({ isTranslation: false }));

    expect(assessRun.mock.calls[0]?.[0].promptType).toBe('Frontend');
  });
});

describe('Recommended run panel effort and reset', () => {
  const sonnetModel = profile.models.find((m) => m.id === 'sonnet')!;
  const haikuModel = profile.models.find((m) => m.id === 'haiku')!;
  const sonnetRecommendation = recommendationFromAssessment(TARGET, {
    ...assessment,
    score: 45,
    complexity: 'moderate',
    modelId: 'sonnet',
    effort: 'medium',
  });

  it('offers the effort levels for Haiku like the other Claude models', () => {
    const state = stateWith({
      status: 'ready',
      recommendation: sonnetRecommendation,
      choice: { model: haikuModel, effort: 'low' },
      isCustom: true,
    });
    renderWithProviders(<RunRecommendationPanel state={state} />);

    const efforts = screen.getByRole('radiogroup', { name: 'Effort' });
    expect(within(efforts).getAllByRole('radio')).toHaveLength(5);
    expect(screen.queryByText(/has no effort setting/)).toBeNull();
  });

  it('puts Use recommended beside Effort when only the effort was changed', () => {
    const state = stateWith({
      status: 'ready',
      recommendation: sonnetRecommendation,
      choice: { model: sonnetModel, effort: 'high' },
      isCustom: true,
    });
    renderWithProviders(<RunRecommendationPanel state={state} />);

    const effortHeader = screen.getByText('Effort').parentElement!;
    const modelHeader = screen.getByText('Model').parentElement!;
    expect(within(effortHeader).getByRole('button', { name: /Use recommended/ })).toBeVisible();
    expect(within(modelHeader).queryByRole('button', { name: /Use recommended/ })).toBeNull();
  });

  it('resets the model and the effort when Use recommended is pressed', async () => {
    const state = stateWith({
      status: 'ready',
      recommendation: sonnetRecommendation,
      choice: { model: haikuModel, effort: 'low' },
      isCustom: true,
    });
    const { user } = renderWithProviders(<RunRecommendationPanel state={state} />);

    const effortHeader = screen.getByText('Effort').parentElement!;
    await user.click(within(effortHeader).getByRole('button', { name: /Use recommended/ }));

    expect(state.reset).toHaveBeenCalledTimes(1);
  });

  it('offers no reset while the choice matches the recommendation', () => {
    const state = stateWith({
      status: 'ready',
      recommendation: sonnetRecommendation,
      choice: sonnetRecommendation.recommended,
    });
    renderWithProviders(<RunRecommendationPanel state={state} />);

    expect(screen.queryByRole('button', { name: /Use recommended/ })).toBeNull();
  });
});
