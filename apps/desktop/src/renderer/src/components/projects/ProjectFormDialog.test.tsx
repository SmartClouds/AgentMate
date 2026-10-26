import type { Project, ProjectRunCommand } from '@runova/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ProjectFormDialog } from './ProjectFormDialog';

const DEFAULT_RUN_COMMANDS: ProjectRunCommand[] = [
  { id: 'dev', label: 'Dev', command: 'pnpm dev' },
  { id: 'prod', label: 'Prod', command: 'pnpm start' },
];

function project(runCommands: ProjectRunCommand[] = DEFAULT_RUN_COMMANDS): Project {
  return {
    id: 'p1',
    name: 'Apollo',
    folderPath: '/work/apollo',
    description: '',
    tags: [],
    agentType: 'claude-code',
    notes: '',
    runCommands,
    cliId: null,
    iconDataUrl: null,
    iconBgColor: null,
    iconColor: null,
    websiteUrl: '',
    repoUrl: '',
  } as unknown as Project;
}

function renderDialog(focusRunCommands?: boolean) {
  return renderWithProviders(
    <ProjectFormDialog
      open
      onOpenChange={vi.fn()}
      initial={project()}
      onSubmit={vi.fn()}
      focusRunCommands={focusRunCommands}
    />,
    { bridge: { 'settings.get': {} } },
  );
}

describe('ProjectFormDialog focusRunCommands', () => {
  it('opens on Basics by default', async () => {
    renderDialog();
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('tab', { name: /Basics/, selected: true })).toBeTruthy();
    expect(within(dialog).queryByLabelText('Command 1')).toBeNull();
  });

  it('opens on the Agent tab with the run commands filled in and the first field focused', async () => {
    renderDialog(true);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('tab', { name: /Agent/, selected: true })).toBeTruthy();
    expect((within(dialog).getByLabelText('Command 1') as HTMLInputElement).value).toBe('pnpm dev');
    expect((within(dialog).getByLabelText('Command 2') as HTMLInputElement).value).toBe(
      'pnpm start',
    );
    await waitFor(() => expect(within(dialog).getByLabelText('Environment 1')).toHaveFocus());
  });
});

describe('ProjectFormDialog project type', () => {
  function renderTyped(initial: Project | undefined) {
    const onOpenChange = vi.fn();
    const onMakeWordPress = vi.fn();
    const onMakeRegular = vi.fn();
    const view = renderWithProviders(
      <ProjectFormDialog
        open
        onOpenChange={onOpenChange}
        initial={initial}
        onSubmit={vi.fn()}
        onMakeWordPress={onMakeWordPress}
        onMakeRegular={onMakeRegular}
      />,
      { bridge: { 'settings.get': {} } },
    );
    return { ...view, onOpenChange, onMakeWordPress, onMakeRegular };
  }

  it('closes the form and starts the WordPress link for a regular project', async () => {
    const { user, onOpenChange, onMakeWordPress, onMakeRegular } = renderTyped(project());
    expect(await screen.findByText('Regular project')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Switch to a regular project/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Switch to a WordPress project/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onMakeWordPress).toHaveBeenCalledTimes(1);
    expect(onMakeRegular).not.toHaveBeenCalled();
  });

  it('closes the form and starts the unlink for a WordPress project', async () => {
    const linked = {
      ...project(),
      wordpress: { siteId: 'site-1', items: [{ kind: 'theme', slug: 'shop' }], linkedAt: '' },
    } as Project;
    const { user, onOpenChange, onMakeRegular } = renderTyped(linked);
    expect(await screen.findByText('WordPress site')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Switch to a regular project/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onMakeRegular).toHaveBeenCalledTimes(1);
  });

  it('leaves the row out of a new project', async () => {
    renderTyped(undefined);
    await screen.findByRole('dialog');
    expect(screen.queryByText('Project type')).toBeNull();
  });
});

function renderWithCommands(runCommands: ProjectRunCommand[]) {
  const onSubmit = vi.fn();
  const view = renderWithProviders(
    <ProjectFormDialog
      open
      onOpenChange={vi.fn()}
      initial={project(runCommands)}
      onSubmit={onSubmit}
      focusRunCommands
    />,
    { bridge: { 'settings.get': {} } },
  );
  return { ...view, onSubmit };
}

describe('ProjectFormDialog run command inputs', () => {
  it('gives every command a button that asks for a value, named by its row', async () => {
    renderDialog(true);
    const dialog = await screen.findByRole('dialog');

    expect(
      within(dialog).getByRole('button', { name: 'Ask for a value in command 1' }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Ask for a value in command 2' }),
    ).toBeTruthy();
  });

  it('explains that button in a styled tooltip, never a native title', async () => {
    const { user } = renderDialog(true);
    const dialog = await screen.findByRole('dialog');

    await user.hover(within(dialog).getByRole('button', { name: 'Ask for a value in command 1' }));

    expect((await screen.findAllByText('Ask for a value when this command runs'))[0]).toBeTruthy();
    expect(document.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('adds a placeholder at the end when the command has never been clicked into', async () => {
    const { user } = renderDialog(true);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Ask for a value in command 1' }));

    const command = within(dialog).getByLabelText('Command 1') as HTMLInputElement;
    expect(command.value).toBe('pnpm dev {{value}}');
    expect(command).toHaveFocus();
    expect([command.selectionStart, command.selectionEnd]).toEqual([11, 16]);
  });

  it('adds a placeholder at the caret once the command has been clicked into', async () => {
    const { user } = renderDialog(true);
    const dialog = await screen.findByRole('dialog');
    const command = within(dialog).getByLabelText('Command 1') as HTMLInputElement;
    await user.click(command);
    command.setSelectionRange(5, 5);

    await user.click(within(dialog).getByRole('button', { name: 'Ask for a value in command 1' }));

    expect(command.value).toBe('pnpm {{value}} dev');
  });

  it('turns selected text into the default, and leaves the new name selected', async () => {
    const { user } = renderDialog(true);
    const dialog = await screen.findByRole('dialog');
    const command = within(dialog).getByLabelText('Command 1') as HTMLInputElement;
    await user.click(command);
    command.setSelectionRange(5, 8);

    await user.click(within(dialog).getByRole('button', { name: 'Ask for a value in command 1' }));

    expect(command.value).toBe('pnpm {{value=dev}}');
    expect(command.value.slice(command.selectionStart ?? 0, command.selectionEnd ?? 0)).toBe(
      'value',
    );
  });

  it('keeps focus in the command field when its button is pressed', async () => {
    const { user } = renderDialog(true);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('Command 1'));

    const button = within(dialog).getByRole('button', {
      name: 'Ask for a value in command 1',
    });
    expect(fireEvent.mouseDown(button)).toBe(false);
  });

  it('says what a command asks for under its row, linked to the command field', async () => {
    renderWithCommands([
      { id: 'serve', label: 'serve', command: 'pnpm dev -- --port {{port=3000}} {{args?}}' },
      { id: 'prod', label: 'prod', command: 'pnpm start' },
    ]);
    const dialog = await screen.findByRole('dialog');

    const line = within(dialog).getByText('Asks for: port (default 3000), args (optional)');
    expect(within(dialog).getByLabelText('Command 1')).toHaveAttribute('aria-describedby', line.id);
    expect(within(dialog).getAllByText(/Asks for:/)).toHaveLength(1);
    expect(within(dialog).getByLabelText('Command 2')).not.toHaveAttribute('aria-describedby');
  });

  it('adds a row that asks for a value, with the caret at the start of its command', async () => {
    const { user } = renderDialog(true);
    const dialog = await screen.findByRole('dialog');

    await user.click(
      within(dialog).getByRole('button', { name: 'Add command that asks for input' }),
    );

    const command = within(dialog).getByLabelText('Command 3') as HTMLInputElement;
    expect(command.value).toBe('{{value}}');
    expect(command).toHaveFocus();
    expect([command.selectionStart, command.selectionEnd]).toEqual([0, 0]);
  });

  it('explains the placeholder syntax in the run commands hint', async () => {
    renderDialog(true);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/\{\{name\}\}/)).toBeTruthy();
  });

  it('saves a command with a placeholder exactly as it was written', async () => {
    const command = { id: 'serve', label: 'serve', command: 'pnpm dev -- --port {{port=3000}}' };
    const { user, onSubmit } = renderWithCommands([command]);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ runCommands: [command] }));
  });
});

describe('ProjectFormDialog create with AI', () => {
  function renderEditor(onCreateWithAi?: () => void) {
    const onOpenChange = vi.fn();
    const view = renderWithProviders(
      <ProjectFormDialog
        open
        onOpenChange={onOpenChange}
        initial={project()}
        onSubmit={vi.fn()}
        focusRunCommands
        onCreateWithAi={onCreateWithAi}
      />,
      { bridge: { 'settings.get': {} } },
    );
    return { ...view, onOpenChange };
  }

  it('has no AI button unless the parent can start one', async () => {
    renderEditor();
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByRole('button', { name: 'Create with AI' })).toBeNull();
  });

  it('closes the form and hands over to the AI dialog', async () => {
    const onCreateWithAi = vi.fn();
    const { user, onOpenChange } = renderEditor(onCreateWithAi);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Create with AI' }));

    expect(onCreateWithAi).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('warns in a styled tooltip that unsaved changes in the form are lost', async () => {
    const { user } = renderEditor(vi.fn());
    const dialog = await screen.findByRole('dialog');

    await user.hover(within(dialog).getByRole('button', { name: 'Create with AI' }));

    expect((await screen.findAllByText(/Unsaved changes here are lost/))[0]).toBeTruthy();
    expect(document.querySelector('[title]')).toBeNull();
  });
});
