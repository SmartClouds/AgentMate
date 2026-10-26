// @vitest-environment jsdom
import type { AppSettings, Project, RunAssessment } from '@runova/core';
import {
  recommendationFromAssessment,
  runProfileForTargetAI,
  targetAIForProject,
} from '@runova/core';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ProjectPromptBuildDialog } from './ProjectPromptBuildDialog';

/**
 * The Build Prompt dialog sizes what Generate or Translate produced by itself while the Build
 * Prompt sizing switch is on. With the switch off it waits, and the Recommended run chip starts
 * the sizing when it is opened. These tests drive both paths through the dialog's own controls,
 * which is where the switch, the size flag and the chip meet.
 */

const project = {
  id: 'p1',
  name: 'Demo',
  folderPath: 'C:/demo',
  agentType: 'claude-code',
  cliId: null,
  iconDataUrl: null,
  iconFile: null,
  iconBgColor: null,
  iconColor: null,
} as Project;

const TARGET = targetAIForProject(project.agentType, project.cliId);
const GENERATED = 'Build the login form with email and password validation.';
const TRANSLATED = 'Translated request';

const assessment: RunAssessment = {
  score: 40,
  complexity: 'moderate',
  signals: [],
  summary: 'A login form with validation.',
  modelId: runProfileForTargetAI(TARGET).models[0]?.id ?? '',
  effort: undefined,
};
const modelLabel = recommendationFromAssessment(TARGET, assessment).recommended.model.label;

const settings = {
  promptBuilderProvider: 'openai',
  openaiModel: 'gpt-4o-mini',
  speechLanguage: 'auto',
} as AppSettings;

/** The dialog with the switch set as given, and a spy on the sizing the CLI would answer. */
function renderDialog(autoSize: boolean) {
  const assessRun = vi.fn(async (_input: { prompt: string; promptType?: string }) => ({
    ok: true,
    assessment,
    cliName: 'Claude Code',
  }));
  const view = renderWithProviders(
    <ProjectPromptBuildDialog open onOpenChange={vi.fn()} projectId="p1" projectName="Demo" />,
    {
      bridge: {
        'settings.get': { ...settings, promptBuilderAutoSize: autoSize },
        'projects.list': [project],
        // No CLI installed, so the run menu offers only the defaults.
        'cli.detectAll': [],
        'ai.ask': async () => ({ ok: true, text: GENERATED }),
        'translate.text': async () => TRANSLATED,
        'ai.assessRun': assessRun,
      },
    },
  );
  return { ...view, assessRun };
}

const requestBox = () => screen.getByLabelText('Your request');
const output = () => screen.getByLabelText<HTMLTextAreaElement>('Generated prompt');
const generateButton = () => screen.getByRole('button', { name: /^Generate prompt/ });
const translateButton = () => screen.getByRole('button', { name: /^Translate/ });
/** The chip while nothing has been sized yet. */
const idleChip = () => screen.getByRole('button', { name: 'Size run' });
/** The chip once a sizing has landed, named after the model it picked. */
const sizedChip = () => screen.getByRole('button', { name: (name) => name.startsWith(modelLabel) });

describe('Build Prompt dialog with Build Prompt sizing on', () => {
  it('sizes the generated prompt as soon as Generate finishes', async () => {
    const { user, assessRun } = renderDialog(true);
    await user.type(requestBox(), 'Add a login form');

    await user.click(generateButton());

    await waitFor(() => expect(assessRun).toHaveBeenCalledTimes(1));
    expect(assessRun.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ prompt: GENERATED, promptType: 'Full Stack' }),
    );
  });

  it('sizes a translation as soon as Translate finishes, without a prompt type', async () => {
    const { user, assessRun } = renderDialog(true);
    await user.type(requestBox(), 'Ajoute un formulaire');

    await user.click(translateButton());

    await waitFor(() => expect(assessRun).toHaveBeenCalledTimes(1));
    const input = assessRun.mock.calls[0]?.[0];
    expect(input?.prompt).toBe(TRANSLATED);
    expect(input?.promptType).toBeUndefined();
  });
});

describe('Build Prompt dialog with Build Prompt sizing off', () => {
  it('does not size the prompt on its own after Generate', async () => {
    const { user, assessRun } = renderDialog(false);
    await user.type(requestBox(), 'Add a login form');

    await user.click(generateButton());

    await waitFor(() => expect(output()).toHaveValue(GENERATED));
    expect(assessRun).not.toHaveBeenCalled();
    expect(idleChip()).toBeInTheDocument();
  });

  it('sizes the prompt when the chip is opened', async () => {
    const { user, assessRun } = renderDialog(false);
    await user.type(requestBox(), 'Add a login form');
    await user.click(generateButton());
    await waitFor(() => expect(output()).toHaveValue(GENERATED));

    await user.click(idleChip());

    await waitFor(() => expect(assessRun).toHaveBeenCalledTimes(1));
    expect(assessRun.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ prompt: GENERATED, promptType: 'Full Stack' }),
    );
    await waitFor(() => expect(sizedChip()).toBeInTheDocument());
  });

  it('does not size a translation until the chip is opened, then sizes it without a prompt type', async () => {
    const { user, assessRun } = renderDialog(false);
    await user.type(requestBox(), 'Ajoute un formulaire');
    await user.click(translateButton());
    await waitFor(() => expect(output()).toHaveValue(TRANSLATED));
    expect(assessRun).not.toHaveBeenCalled();

    await user.click(idleChip());

    await waitFor(() => expect(assessRun).toHaveBeenCalledTimes(1));
    const input = assessRun.mock.calls[0]?.[0];
    expect(input?.prompt).toBe(TRANSLATED);
    expect(input?.promptType).toBeUndefined();
  });

  it('sizes the edited prompt again when the chip is opened after an edit', async () => {
    const { user, assessRun } = renderDialog(false);
    await user.type(requestBox(), 'Add a login form');
    await user.click(generateButton());
    await waitFor(() => expect(output()).toHaveValue(GENERATED));
    await user.click(idleChip());
    await waitFor(() => expect(assessRun).toHaveBeenCalledTimes(1));
    // Closing the panel leaves the chip as the only control named after the model.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(sizedChip()).toBeInTheDocument());

    await user.type(output(), ' Add tests.');
    expect(assessRun).toHaveBeenCalledTimes(1);
    await user.click(sizedChip());

    await waitFor(() => expect(assessRun).toHaveBeenCalledTimes(2));
    expect(assessRun.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ prompt: `${GENERATED} Add tests.` }),
    );
  });
});
