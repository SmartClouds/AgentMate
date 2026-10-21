// @vitest-environment jsdom
import {
  AGENT_TYPE_LABELS,
  blueprintTextHash,
  buildBlueprintPrompt,
  createBlankBlueprint,
  type Project,
  type ProjectBlueprint,
  targetAIForProject,
} from '@agentmat/core';
import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { useProjectBlueprint } from './useBlueprint';

/**
 * generate() writes the Blueprint prompt with whatever the user picked: an agent CLI with a model
 * and effort, or the provider from Settings. These pin which path each choice takes, that a
 * failure still leaves a usable prompt, and that a cancel leaves nothing behind.
 */

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const project = {
  id: 'p1',
  name: 'Apollo',
  agentType: 'claude-code',
  cliId: 'claude-code',
  folderPath: '/work/apollo',
} as unknown as Project;

const IDEA = 'A booking app for climbing gyms.';

function blueprint(): ProjectBlueprint {
  const blank = createBlankBlueprint('b1', project.id);
  return {
    ...blank,
    sections: blank.sections.map((section) =>
      section.stepId === 'idea'
        ? { ...section, text: IDEA, textEn: IDEA, textEnHash: blueprintTextHash(IDEA) }
        : section,
    ),
  };
}

const SETTINGS = {
  promptBuilderProvider: 'openai',
  openaiModel: 'gpt-test',
  geminiModel: '',
  ollamaModel: '',
};

function setup(overrides: Record<string, unknown> = {}) {
  const view = renderHookWithProviders(() => useProjectBlueprint(project), {
    bridge: {
      'blueprints.get': blueprint(),
      'blueprints.listPresets': [],
      'blueprints.agentFileTarget': async () => null,
      'blueprints.setFinalPrompt': async (_id: string, text: string) => ({
        ...blueprint(),
        finalPrompt: text,
      }),
      'settings.get': SETTINGS,
      'ai.askCli': { ok: true, text: 'Written by the CLI', cliName: 'Claude Code CLI' },
      'ai.ask': { ok: true, text: 'Written by the API' },
      ...overrides,
    },
  });
  return view;
}

beforeEach(() => {
  for (const fn of Object.values(toast)) fn.mockClear();
});

describe('useProjectBlueprint generate', () => {
  it('writes with the picked CLI, model and effort, and saves what it wrote', async () => {
    const { result, bridge } = setup();
    await waitFor(() => expect(result.current.blueprint).toBeDefined());

    let written: string | null = null;
    await act(async () => {
      written = await result.current.generate({
        cliId: 'claude-code',
        modelId: 'opus',
        effort: 'high',
      });
    });

    expect(written).toBe('Written by the CLI');
    const [input] = bridge.$fn('ai.askCli').mock.calls[0] as [Record<string, unknown>];
    expect(input).toMatchObject({ cliId: 'claude-code', modelId: 'opus', effort: 'high' });
    expect(input.prompt).toContain(IDEA);
    expect(typeof input.requestId).toBe('string');
    expect(() => bridge.$fn('ai.ask')).toThrow();
    expect(bridge.$fn('blueprints.setFinalPrompt')).toHaveBeenCalledWith(
      'p1',
      'Written by the CLI',
    );
    // The caller announces the new prompt; a "Prompt saved." here would stack on top of it.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('keeps using the Settings provider when no CLI was picked', async () => {
    const { result, bridge } = setup();
    await waitFor(() => expect(result.current.blueprint).toBeDefined());

    let written: string | null = null;
    await act(async () => {
      written = await result.current.generate({ cliId: null, modelId: null, effort: null });
    });

    expect(written).toBe('Written by the API');
    expect(bridge.$fn('ai.ask').mock.calls[0]?.[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
    });
    expect(() => bridge.$fn('ai.askCli')).toThrow();
  });

  it('falls back to the local template when the CLI fails, and says why', async () => {
    const { result } = setup({
      'ai.askCli': {
        ok: false,
        text: '',
        cliName: 'Claude Code CLI',
        error: "Claude Code CLI wasn't found.",
      },
    });
    await waitFor(() => expect(result.current.blueprint).toBeDefined());

    let written: string | null = null;
    await act(async () => {
      written = await result.current.generate({
        cliId: 'claude-code',
        modelId: null,
        effort: null,
      });
    });

    expect(written).toBe(
      buildBlueprintPrompt({
        projectName: 'Apollo',
        agentLabel: AGENT_TYPE_LABELS[project.agentType],
        targetAI: targetAIForProject(project.agentType, project.cliId),
        docsFolder: 'docs',
        confirmBeforeWriting: true,
        sections: [{ stepId: 'idea', text: IDEA, attachmentNames: [] }],
      }),
    );
    expect(toast.warning).toHaveBeenCalledWith(
      "Claude Code CLI wasn't found. Assembled the prompt here instead.",
    );
  });

  it('saves nothing when the user cancels while the CLI is writing', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const { result, bridge } = setup({
      'ai.askCli': () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await waitFor(() => expect(result.current.blueprint).toBeDefined());

    let pending: Promise<string | null> = Promise.resolve(null);
    act(() => {
      pending = result.current.generate({ cliId: 'claude-code', modelId: null, effort: null });
    });
    await waitFor(() => expect(result.current.generateStage).toBe('writing'));

    act(() => result.current.cancelGenerate());
    const [input] = bridge.$fn('ai.askCli').mock.calls[0] as [{ requestId: string }];
    expect(bridge.$fn('ai.cancelAskCli')).toHaveBeenCalledWith(input.requestId);

    let written: string | null = 'unset';
    await act(async () => {
      finish({ ok: false, text: '', cliName: 'Claude Code CLI', cancelled: true });
      written = await pending;
    });

    expect(written).toBeNull();
    expect(() => bridge.$fn('blueprints.setFinalPrompt')).toThrow();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(result.current.generateStage).toBe('idle');
  });

  it('never asks the CLI when the user cancels during translation', async () => {
    const persian = 'یک برنامه رزرو';
    const blank = createBlankBlueprint('b1', project.id);
    let translated: (value: string) => void = () => undefined;
    const { result, bridge } = setup({
      'blueprints.get': {
        ...blank,
        sections: blank.sections.map((section) =>
          section.stepId === 'idea' ? { ...section, text: persian } : section,
        ),
      },
      'translate.text': () =>
        new Promise((resolve) => {
          translated = resolve;
        }),
    });
    await waitFor(() => expect(result.current.blueprint).toBeDefined());

    let pending: Promise<string | null> = Promise.resolve(null);
    act(() => {
      pending = result.current.generate({ cliId: 'claude-code', modelId: null, effort: null });
    });
    await waitFor(() => expect(result.current.generateStage).toBe('translating'));

    act(() => result.current.cancelGenerate());
    let written: string | null = 'unset';
    await act(async () => {
      translated('A booking app');
      written = await pending;
    });

    expect(written).toBeNull();
    expect(() => bridge.$fn('ai.askCli')).toThrow();
    expect(() => bridge.$fn('ai.cancelAskCli')).toThrow();
  });
});

describe('useProjectBlueprint and the Relay split', () => {
  const split = (): ProjectBlueprint => ({
    ...blueprint(),
    relay: { enabled: true, budgetTokens: 400_000 },
  });

  it('asks the CLI for Relay task files sized to the budget instead of a backlog', async () => {
    const { result, bridge } = setup({
      'blueprints.get': split(),
      'ai.askCli': { ok: false, text: '', cliName: 'Claude Code CLI', error: 'Offline.' },
    });
    await waitFor(() => expect(result.current.blueprint).toBeDefined());

    let written: string | null = null;
    await act(async () => {
      written = await result.current.generate({
        cliId: 'claude-code',
        modelId: null,
        effort: null,
      });
    });

    const [call] = bridge.$fn('ai.askCli').mock.calls;
    const request = (call[0] as { prompt: string }).prompt;
    expect(request).toContain('docs/tasks/');
    expect(request).toContain('400K');
    expect(written).toContain('docs/tasks/RELAY.md');
    expect(written).not.toContain('BACKLOG.md');
  });

  it('saves the switch and the budget', async () => {
    const { result, bridge } = setup({
      'blueprints.setRelay': async () => split(),
    });
    await waitFor(() => expect(result.current.blueprint).toBeDefined());

    await act(async () => {
      await result.current.setRelay.mutateAsync({ enabled: true, budgetTokens: 400_000 });
    });

    expect(bridge.$fn('blueprints.setRelay')).toHaveBeenCalledWith('p1', {
      enabled: true,
      budgetTokens: 400_000,
    });
    await waitFor(() =>
      expect(result.current.blueprint?.relay).toEqual({ enabled: true, budgetTokens: 400_000 }),
    );
  });
});
