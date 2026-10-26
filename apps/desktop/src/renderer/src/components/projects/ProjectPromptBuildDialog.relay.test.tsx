import type { AppSettings, Project } from '@runova/core';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ProjectPromptBuildDialog } from './ProjectPromptBuildDialog';

/** Build Prompt hands its request to Relay, which splits it into tasks that fit one session. */

const project = {
  id: 'p-relay',
  name: 'Demo',
  folderPath: 'C:/demo',
  agentType: 'claude-code',
  cliId: null,
} as Project;

const GENERATED = 'Build the login form with email and password validation.';

function renderDialog() {
  return renderWithProviders(
    <ProjectPromptBuildDialog open onOpenChange={vi.fn()} projectId="p-relay" projectName="Demo" />,
    {
      bridge: {
        'settings.get': {
          promptBuilderProvider: 'openai',
          openaiModel: 'gpt-4o-mini',
          speechLanguage: 'auto',
          promptBuilderAutoSize: false,
        } as AppSettings,
        'projects.list': [project],
        'cli.detectAll': [],
        'ai.ask': async () => ({ ok: true, text: GENERATED }),
      },
    },
  );
}

describe('Build Prompt dialog, Split into tasks', () => {
  it('splits the request when nothing was generated yet', async () => {
    const { user } = renderDialog();
    expect(screen.getByRole('button', { name: 'Split into tasks' })).toBeDisabled();

    await user.type(screen.getByLabelText('Your request'), 'Add a login form');
    await user.click(screen.getByRole('button', { name: 'Split into tasks' }));

    const dialog = await screen.findByRole('dialog', { name: 'Split into tasks' });
    expect(
      within(dialog).getByRole('textbox', { name: 'What should the tasks deliver?' }),
    ).toHaveValue('Add a login form');
    expect(within(dialog).queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument();
  });

  it('splits the generated prompt once there is one', async () => {
    const { user } = renderDialog();
    await user.type(screen.getByLabelText('Your request'), 'Add a login form');
    await user.click(screen.getByRole('button', { name: /^Generate prompt/ }));
    await waitFor(() => expect(screen.getByLabelText('Generated prompt')).toHaveValue(GENERATED));

    await user.click(screen.getByRole('button', { name: 'Split into tasks' }));

    const dialog = await screen.findByRole('dialog', { name: 'Split into tasks' });
    expect(
      within(dialog).getByRole('textbox', { name: 'What should the tasks deliver?' }),
    ).toHaveValue(GENERATED);
  });
});
