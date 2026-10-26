// @vitest-environment jsdom
import { createBlankBlueprint, type Project, type ProjectBlueprint } from '@runova/core';
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBlueprintGeneratorStore } from '@/stores/blueprintGeneratorStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { BlueprintReviewStep } from './BlueprintReviewStep';

/**
 * The Review step's two ways out of a written prompt: choosing what writes it (CLI, model,
 * effort, or the Settings provider) right at the Generate button, and running it in an agent
 * CLI from the action bar or from the toast that announces it.
 */

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

// CodeMirror needs a layout engine jsdom doesn't have; a textarea is all these tests read.
vi.mock('@/components/editor/MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Prompt editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

// The run dialog has its own tests; here it only matters that it opens with the right prompt.
vi.mock('@/components/workspace/FixWithAiDialog', () => ({
  FixWithAiDialog: (props: { open: boolean; source: { prompt: string }; promptType: string }) =>
    props.open ? (
      <div role="dialog" aria-label="Run dialog" data-prompt-type={props.promptType}>
        {props.source.prompt}
      </div>
    ) : null,
}));

const project = {
  id: 'p1',
  name: 'Apollo',
  agentType: 'claude-code',
  cliId: 'claude-code',
  folderPath: '/work/apollo',
} as unknown as Project;

function blueprint(finalPrompt = ''): ProjectBlueprint {
  const blank = createBlankBlueprint('b1', project.id);
  return {
    ...blank,
    finalPrompt,
    finalPromptUpdatedAt: finalPrompt ? '2026-10-03T00:00:00.000Z' : null,
    sections: blank.sections.map((section) =>
      section.stepId === 'idea' ? { ...section, text: 'A booking app.' } : section,
    ),
  };
}

const SETTINGS = {
  promptBuilderProvider: 'openai',
  openaiModel: 'gpt-test',
  geminiModel: '',
  ollamaModel: '',
};

function renderStep(
  options: {
    finalPrompt?: string;
    installed?: string[];
    onGenerate?: (choice: unknown) => Promise<string | null>;
    relay?: { enabled: boolean; budgetTokens: number };
  } = {},
) {
  const onGenerate = vi.fn(options.onGenerate ?? (async () => 'New prompt'));
  const onRelayChange = vi.fn();
  const view = renderWithProviders(
    <BlueprintReviewStep
      project={project}
      blueprint={{
        ...blueprint(options.finalPrompt),
        relay: options.relay ?? { enabled: false, budgetTokens: 200_000 },
      }}
      generateStage="idle"
      onGenerate={onGenerate}
      onCancelGenerate={vi.fn()}
      onSavePrompt={vi.fn()}
      onDocsFolderChange={vi.fn()}
      onConfirmBeforeWritingChange={vi.fn()}
      onRelayChange={onRelayChange}
      onOpenHistory={vi.fn()}
      savingPrompt={false}
    />,
    {
      bridge: {
        platform: 'win32',
        'settings.get': SETTINGS,
        'cli.detectAll': (options.installed ?? ['claude-code']).map((id) => ({
          id,
          installed: true,
        })),
      },
    },
  );
  return { ...view, onGenerate, onRelayChange };
}

beforeEach(() => {
  for (const fn of Object.values(toast)) fn.mockClear();
});

describe('BlueprintReviewStep generator', () => {
  it("starts on the project's CLI and says so next to the button", async () => {
    renderStep();
    expect(await screen.findByText('Claude Code · CLI default model')).toBeInTheDocument();
  });

  it('shows the remembered model and effort', async () => {
    useBlueprintGeneratorStore
      .getState()
      .setChoice('p1', { cliId: 'claude-code', modelId: 'opus', effort: 'high' });
    renderStep();
    expect(await screen.findByText('Claude Code · Opus 5.5 · High')).toBeInTheDocument();
  });

  it('falls back to the Settings provider when no CLI can answer a one-shot prompt', async () => {
    renderStep({ installed: [] });
    expect(await screen.findByText('OpenAI · gpt-test (Settings)')).toBeInTheDocument();
  });

  it('generates with the current choice and offers to run the result', async () => {
    useBlueprintGeneratorStore
      .getState()
      .setChoice('p1', { cliId: 'claude-code', modelId: 'sonnet', effort: 'low' });
    const { user, onGenerate } = renderStep();
    await screen.findByText('Claude Code · Sonnet 5.5 · Low');

    await user.click(screen.getByRole('button', { name: /^Generate prompt$/ }));

    expect(onGenerate).toHaveBeenCalledWith({
      cliId: 'claude-code',
      modelId: 'sonnet',
      effort: 'low',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [title, options] = toast.success.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe('Prompt ready');
    expect(options.action.label).toBe('Run in CLI');

    act(() => options.action.onClick());
    expect(await screen.findByRole('dialog', { name: 'Run dialog' })).toBeInTheDocument();
  });

  it('stays quiet when nothing was written', async () => {
    const { user } = renderStep({ onGenerate: async () => null });
    await screen.findByText('Claude Code · CLI default model');
    await user.click(screen.getByRole('button', { name: /^Generate prompt$/ }));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('changes the effort from the popover and remembers it', async () => {
    useBlueprintGeneratorStore
      .getState()
      .setChoice('p1', { cliId: 'claude-code', modelId: 'opus', effort: 'high' });
    const { user } = renderStep();
    await screen.findByText('Claude Code · Opus 5.5 · High');

    await user.click(
      screen.getByRole('button', { name: 'Choose the model and effort for generating' }),
    );
    await user.click(await screen.findByRole('radio', { name: 'Max' }));

    expect(useBlueprintGeneratorStore.getState().choices.p1).toEqual({
      cliId: 'claude-code',
      modelId: 'opus',
      effort: 'max',
    });
    expect(screen.getByText('Claude Code · Opus 5.5 · Max')).toBeInTheDocument();
  });
});

describe('BlueprintReviewStep Run in CLI', () => {
  it('is off until there is a prompt', async () => {
    renderStep();
    expect(await screen.findByRole('button', { name: /Run in CLI/ })).toBeDisabled();
  });

  it('opens the run dialog on the text in the editor', async () => {
    const { user } = renderStep({ finalPrompt: 'Act as the product manager.' });
    const editor = screen.getByRole('textbox', { name: 'Prompt editor' });
    await user.type(editor, ' Edited.');

    await user.click(screen.getByRole('button', { name: /Run in CLI/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Run dialog' });
    expect(dialog).toHaveTextContent('Act as the product manager. Edited.');
    expect(dialog).toHaveAttribute('data-prompt-type', 'Product');
  });
});

describe('BlueprintReviewStep Relay split', () => {
  it('turns the split on at the default budget', async () => {
    const { user, onRelayChange } = renderStep();

    expect(screen.queryByRole('radiogroup', { name: 'Session budget' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Split into Relay tasks' }));

    expect(onRelayChange).toHaveBeenCalledWith({ enabled: true, budgetTokens: 200_000 });
  });

  it('changes the budget while the split is on', async () => {
    const { user, onRelayChange } = renderStep({
      relay: { enabled: true, budgetTokens: 200_000 },
    });

    await user.click(screen.getByRole('radio', { name: '400K' }));

    expect(onRelayChange).toHaveBeenCalledWith({ enabled: true, budgetTokens: 400_000 });
  });

  it('puts the Relay guide in the project before running the prompt', async () => {
    const { user, bridge } = renderStep({
      finalPrompt: 'Plan it',
      relay: { enabled: true, budgetTokens: 200_000 },
    });

    await user.click(screen.getByRole('button', { name: 'Run in CLI' }));

    expect(await screen.findByRole('dialog', { name: 'Run dialog' })).toBeInTheDocument();
    expect(bridge.$fn('relay.ensureGuide')).toHaveBeenCalledWith('p1', 'docs');
  });

  it('leaves the project alone when the split is off', async () => {
    const { user, bridge } = renderStep({ finalPrompt: 'Plan it' });

    await user.click(screen.getByRole('button', { name: 'Run in CLI' }));

    expect(await screen.findByRole('dialog', { name: 'Run dialog' })).toBeInTheDocument();
    expect(() => bridge.$fn('relay.ensureGuide')).toThrow();
  });
});
