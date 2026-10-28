// @vitest-environment jsdom
import type { AppSettings } from '@runova/core';
import type { PromptHistoryEntry } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MonacoEditorProps } from '@/components/editor/MonacoEditor';
import { usePromptBuilderStore } from '@/stores/promptBuilderStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * Prompt Builder turns a rough description into a prompt through an AI provider. Everything that
 * matters crosses the bridge (the provider call, the template, the history), so the tests drive
 * the two text areas and assert on what was sent and what came back on screen.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

/**
 * The generated prompt lives in Monaco, which needs workers and layout measurement jsdom has
 * neither of. A plain controlled textarea keeps the contract the page uses: it shows the value
 * and reports edits back.
 */
vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value, onChange }: MonacoEditorProps) => (
    <textarea
      aria-label="Generated prompt"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

const { default: PromptBuilderPage } = await import('./PromptBuilderPage');

const settings = {
  promptBuilderProvider: 'openai',
  openaiModel: 'gpt-4o-mini',
  geminiModel: 'gemini-2.0-flash',
  ollamaModel: 'llama3',
  speechLanguage: 'en',
} as AppSettings;

function historyEntry(overrides: Partial<PromptHistoryEntry> = {}): PromptHistoryEntry {
  return {
    id: 'h1',
    rawInput: 'ship the login form',
    promptType: 'Frontend',
    targetAI: 'Claude',
    content: '# Login form\nBuild it.',
    source: 'generate',
    projectId: null,
    createdAt: new Date('2026-02-01T09:00:00.000Z').toISOString(),
    ...overrides,
  } as PromptHistoryEntry;
}

function renderPage(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<PromptBuilderPage />, {
    route: '/prompt-builder',
    bridge: { 'settings.get': settings, ...bridge },
  });
}

const request = () => screen.getByLabelText('Your request');
const output = () => screen.getByLabelText<HTMLTextAreaElement>('Generated prompt');

/** One of the page's five comboboxes, found through the label above it. */
function picker(label: string): HTMLElement {
  const group = screen.getByText(label).parentElement;
  if (!group) throw new Error(`No field around the "${label}" label`);
  return within(group).getByRole('combobox');
}

/** The actions under the output. Copy and Clear are icon-only, in that order. */
function actionRow(): HTMLElement {
  const row = screen.getByRole('button', { name: /Save Template/ }).parentElement;
  if (!row) throw new Error('The output actions are missing');
  return row;
}

function iconAction(index: number): HTMLElement {
  const icons = within(actionRow())
    .getAllByRole('button')
    .filter((button) => !button.textContent?.trim());
  const found = icons[index];
  if (!found) throw new Error(`No icon action at ${index}, found ${icons.length}`);
  return found;
}

describe('PromptBuilderPage first load', () => {
  it('renders an empty builder against a bridge that answers nothing', async () => {
    renderWithProviders(<PromptBuilderPage />, { route: '/prompt-builder' });

    expect(await screen.findByRole('button', { name: /Generate Prompt/ })).toBeInTheDocument();
    expect(request()).toHaveValue('');
    expect(output()).toHaveValue('');
    // Nothing has been generated, so everything that acts on the output is out of reach.
    expect(screen.getByRole('button', { name: /Save Template/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Export Markdown/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Send to CLI/ })).toBeDisabled();
  });

  it('offers the projects the bridge knows about and attaches the request to one', async () => {
    usePromptBuilderStore.setState({ rawInput: 'add a login form' });
    const { user, bridge } = renderPage({
      'projects.list': [{ id: 'p1', name: 'Atlas', agentType: 'claude', cliId: 'claude-code' }],
    });
    await screen.findByRole('button', { name: /Generate Prompt/ });
    expect(bridge.$fn('projects.list')).toHaveBeenCalled();
    // Without a project there is nowhere to park a draft.
    expect(screen.getByRole('button', { name: /Save draft to project/ })).toBeDisabled();

    await user.click(picker('Project'));
    await user.click(await screen.findByRole('option', { name: 'Atlas' }));

    expect(within(picker('Project')).getByText('Atlas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save draft to project/ })).toBeEnabled();
  });
});

describe('PromptBuilderPage generating', () => {
  it('sends the described request to the provider and shows what came back', async () => {
    const { user, bridge } = renderPage({
      'translate.text': async () => 'add a login form',
      'ai.ask': async () => ({ ok: true, text: '  # Login form\nBuild it.  ' }),
    });
    await screen.findByRole('button', { name: /Generate Prompt/ });

    await user.type(request(), 'add a login form');
    await user.click(screen.getByRole('button', { name: /Generate Prompt/ }));

    await waitFor(() => expect(output()).toHaveValue('# Login form\nBuild it.'));
    expect(bridge.$fn('ai.ask')).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', model: 'gpt-4o-mini' }),
    );
    // The description is normalized to English before it is folded into the request.
    expect(bridge.$fn('translate.text')).toHaveBeenCalledWith({
      text: 'add a login form',
      targetLang: 'en',
    });
    await waitFor(() =>
      expect(bridge.$fn('promptHistory.add')).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'generate', content: '# Login form\nBuild it.' }),
      ),
    );
    expect(screen.getByRole('button', { name: /Save Template/ })).toBeEnabled();
  });

  it('still sizes the prompt straight after Generate when the Build Prompt switch is off', async () => {
    // The switch belongs to the Build Prompt dialog. The page keeps sizing as it always has.
    const assessRun = vi.fn(async () => ({ ok: false, error: 'No CLI installed.' }));
    const { user } = renderPage({
      'settings.get': { ...settings, promptBuilderAutoSize: false },
      'ai.ask': async () => ({ ok: true, text: 'Build it.' }),
      'ai.assessRun': assessRun,
    });
    await screen.findByRole('button', { name: /Generate Prompt/ });

    await user.type(request(), 'add a login form');
    await user.click(screen.getByRole('button', { name: /Generate Prompt/ }));

    await waitFor(() => expect(assessRun).toHaveBeenCalledTimes(1));
    expect(assessRun).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Build it.' }));
  });

  it('asks for a description first rather than generating from nothing', async () => {
    const { user, bridge } = renderPage();
    await screen.findByRole('button', { name: /Generate Prompt/ });

    await user.click(screen.getByRole('button', { name: /Generate Prompt/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Describe what you want before generating a prompt.',
      ),
    );
    expect(bridge.ai.ask).not.toHaveBeenCalled();
  });

  it('points at Settings when the chosen provider has no model', async () => {
    const { user, bridge } = renderPage({
      'settings.get': { ...settings, promptBuilderProvider: 'gemini', geminiModel: '' },
    });
    await screen.findByRole('button', { name: /Generate Prompt/ });

    await user.type(request(), 'anything');
    await user.click(screen.getByRole('button', { name: /Generate Prompt/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Set a gemini model in Settings first.'),
    );
    expect(bridge.ai.ask).not.toHaveBeenCalled();
  });

  it('shows the provider’s refusal instead of a blank output', async () => {
    const { user } = renderPage({
      'ai.ask': async () => ({ ok: false, error: 'Rate limit reached.' }),
    });
    await screen.findByRole('button', { name: /Generate Prompt/ });

    await user.type(request(), 'add a login form');
    await user.click(screen.getByRole('button', { name: /Generate Prompt/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Rate limit reached.'));
    expect(output()).toHaveValue('');
    // The page is still usable, so the user can fix the key and press it again.
    expect(screen.getByRole('button', { name: /Generate Prompt/ })).toBeEnabled();
  });

  it('turns a thrown provider error into a toast rather than an empty page', async () => {
    const { user } = renderPage({
      'ai.ask': () => Promise.reject(new Error('fetch failed')),
    });
    await screen.findByRole('button', { name: /Generate Prompt/ });

    await user.type(request(), 'add a login form');
    await user.click(screen.getByRole('button', { name: /Generate Prompt/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('fetch failed'));
    expect(screen.getByRole('button', { name: /Generate Prompt/ })).toBeEnabled();
    expect(request()).toHaveValue('add a login form');
  });
});

describe('PromptBuilderPage translating', () => {
  it('translates the request straight into the output', async () => {
    const { user, bridge } = renderPage({ 'translate.text': async () => 'salam donya' });
    await screen.findByRole('button', { name: /Translate/ });

    await user.type(request(), 'hello world');
    await user.click(screen.getByRole('button', { name: /Translate/ }));

    await waitFor(() => expect(output()).toHaveValue('salam donya'));
    expect(bridge.$fn('translate.text')).toHaveBeenCalledWith({
      text: 'hello world',
      targetLang: 'en',
    });
    // A translation is not shaped by a prompt type or aimed at an AI, so both are logged empty.
    await waitFor(() =>
      expect(bridge.$fn('promptHistory.add')).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'translate', promptType: '', targetAI: '' }),
      ),
    );
  });

  it('blames the connection when the translation service cannot be reached', async () => {
    const { user } = renderPage({
      'translate.text': () => Promise.reject(new Error('ENOTFOUND')),
    });
    await screen.findByRole('button', { name: /Translate/ });

    await user.type(request(), 'hello world');
    await user.click(screen.getByRole('button', { name: /Translate/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Translation failed. Check your internet connection and try again.',
      ),
    );
    expect(output()).toHaveValue('');
  });
});

describe('PromptBuilderPage output actions', () => {
  it('copies the generated prompt to the clipboard', async () => {
    usePromptBuilderStore.setState({ generated: '# Login form' });
    const { user } = renderPage();
    await screen.findByRole('button', { name: /Save Template/ });

    await user.click(iconAction(0));

    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('# Login form'));
    expect(toast.success).toHaveBeenCalledWith('Copied to clipboard.');
  });

  it('saves the prompt as a named template', async () => {
    usePromptBuilderStore.setState({
      generated: '# Login form',
      promptType: 'Frontend',
      targetAI: 'Claude Code',
    });
    const { user, bridge } = renderPage();

    await user.click(await screen.findByRole('button', { name: /Save Template/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Save prompt template')).toBeInTheDocument();
    // An unnamed template would be impossible to find again.
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.type(within(dialog).getByPlaceholderText('Template name'), 'Login form');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(bridge.$fn('templates.save')).toHaveBeenCalledWith({
        name: 'Login form',
        promptType: 'Frontend',
        targetAI: 'Claude Code',
        content: '# Login form',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Template saved.');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('writes the prompt to a file and says where it went', async () => {
    usePromptBuilderStore.setState({ generated: '# Login form' });
    const { user, bridge } = renderPage({ 'fs.saveFileAs': async () => 'C:/tmp/prompt.md' });
    await screen.findByRole('button', { name: /Export Markdown/ });

    await user.click(screen.getByRole('button', { name: /Export Markdown/ }));

    await waitFor(() =>
      expect(bridge.$fn('fs.saveFileAs')).toHaveBeenCalledWith('prompt.md', '# Login form'),
    );
    expect(toast.success).toHaveBeenCalledWith('Saved to C:/tmp/prompt.md');
  });

  it('opens a terminal with the prompt piped into the default CLI', async () => {
    usePromptBuilderStore.setState({ generated: '# Login form' });
    const { user, bridge } = renderPage({
      'fs.writeScratchFile': async () => 'C:/tmp/prompt-1.md',
    });
    await screen.findByRole('button', { name: /Send to CLI/ });

    await user.click(screen.getByRole('button', { name: /Send to CLI/ }));

    await waitFor(() => expect(bridge.$fn('fs.writeScratchFile')).toHaveBeenCalled());
    await waitFor(() => expect(useTerminalStore.getState().sessions).toHaveLength(1));
    // Nothing is run for the user: the command waits in a session they still have to accept.
    expect(useTerminalStore.getState().sessions[0].initialInput).toContain('C:/tmp/prompt-1.md');
  });

  it('empties both boxes when the builder is cleared', async () => {
    usePromptBuilderStore.setState({ generated: '# Login form', rawInput: 'add a login form' });
    const { user } = renderPage();
    await screen.findByRole('button', { name: /Save Template/ });

    await user.click(iconAction(1));

    await waitFor(() => expect(output()).toHaveValue(''));
    expect(request()).toHaveValue('');
  });
});

describe('PromptBuilderPage history', () => {
  it('lists past prompts and loads the one that is picked', async () => {
    const { user, bridge } = renderPage({ 'promptHistory.list': [historyEntry()] });

    await user.click(await screen.findByRole('button', { name: /History/ }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Frontend')).toBeInTheDocument();
    expect(bridge.$fn('promptHistory.list')).toHaveBeenCalled();

    await user.click(within(dialog).getByText('Frontend'));

    await waitFor(() => expect(output()).toHaveValue('# Login form\nBuild it.'));
    expect(request()).toHaveValue('ship the login form');
    expect(toast.success).toHaveBeenCalledWith('Loaded from history.');
  });

  it('searches the history through the bridge instead of filtering on screen', async () => {
    const { user, bridge } = renderPage({
      'promptHistory.list': [historyEntry()],
      'promptHistory.search': [historyEntry({ id: 'h2', promptType: 'Backend' })],
    });

    await user.click(await screen.findByRole('button', { name: /History/ }));
    await user.type(await screen.findByPlaceholderText('Search prompt history…'), 'backend');

    await waitFor(() => expect(bridge.$fn('promptHistory.search')).toHaveBeenCalledWith('backend'));
    expect(await screen.findByText('Backend')).toBeInTheDocument();
  });

  it('offers a retry when the history could not be read', async () => {
    const { user } = renderPage({
      'promptHistory.list': () => Promise.reject(new Error('database is locked')),
    });

    await user.click(await screen.findByRole('button', { name: /History/ }));

    expect(await screen.findByText('Couldn’t load prompt history.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('says the history is empty rather than showing a bare dialog', async () => {
    const { user } = renderPage({ 'promptHistory.list': [] });

    await user.click(await screen.findByRole('button', { name: /History/ }));

    expect(
      await screen.findByText(/Nothing here yet\. Generate or translate a prompt/),
    ).toBeInTheDocument();
  });
});

describe('PromptBuilderPage drafts', () => {
  it('needs a project before a draft has somewhere to live', async () => {
    usePromptBuilderStore.setState({ rawInput: 'add a login form', projectId: null });
    renderPage();

    expect(
      await screen.findByText(/Choose a project above to park this request on it as a draft\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save draft to project/ })).toBeDisabled();
  });

  it('parks the request on the chosen project', async () => {
    usePromptBuilderStore.setState({
      rawInput: 'add a login form',
      projectId: 'p1',
      promptType: 'Frontend',
      targetAI: 'Claude',
      generated: '# Login form',
    });
    const { user, bridge } = renderPage({
      'projects.list': [{ id: 'p1', name: 'Atlas', agentType: 'claude', cliId: 'claude-code' }],
    });

    await user.click(await screen.findByRole('button', { name: /Save draft to project/ }));

    await waitFor(() =>
      expect(bridge.$fn('projectDrafts.create')).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1', rawInput: 'add a login form' }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'Draft saved. Find it under the project’s Prompts section.',
    );
  });

  it('says the draft did not save when the bridge rejects it', async () => {
    usePromptBuilderStore.setState({ rawInput: 'add a login form', projectId: 'p1' });
    const { user } = renderPage({
      'projects.list': [{ id: 'p1', name: 'Atlas', agentType: 'claude', cliId: 'claude-code' }],
      'projectDrafts.create': () => Promise.reject(new Error('disk full')),
    });

    await user.click(await screen.findByRole('button', { name: /Save draft to project/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save the draft.'));
  });
});

describe('PromptBuilderPage scheduled series', () => {
  it('saves each queued task as automatic by default, with the chosen time', async () => {
    usePromptBuilderStore.setState({
      rawInput: 'bump dependencies',
      projectId: 'p1',
      status: 'scheduled',
      promptType: 'Frontend',
      targetAI: 'Claude',
    });
    const { user, bridge } = renderPage({
      'projects.list': [{ id: 'p1', name: 'Atlas', agentType: 'claude', cliId: 'claude-code' }],
    });

    await user.click(await screen.findByRole('button', { name: /Add task/ }));
    await user.click(screen.getByRole('button', { name: /Save 1 task\(s\) to schedule/ }));

    await waitFor(() =>
      expect(bridge.$fn('scheduledTasks.createMany')).toHaveBeenCalledWith({
        projectId: 'p1',
        tasks: [
          expect.objectContaining({
            rawInput: 'bump dependencies',
            runMode: 'auto',
            runAt: expect.stringMatching(/Z$/),
          }),
        ],
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'Scheduled series saved. Find it under the project’s Prompts section.',
    );
  });
});

describe('PromptBuilderPage composer', () => {
  it('generates from the keyboard with Ctrl+Enter in the request box', async () => {
    const { user, bridge } = renderPage({
      'translate.text': async () => 'add a login form',
      'ai.ask': async () => ({ ok: true, text: '# Login form' }),
    });
    await screen.findByRole('button', { name: /Generate Prompt/ });

    await user.type(request(), 'add a login form');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(output()).toHaveValue('# Login form'));
    expect(bridge.$fn('ai.ask')).toHaveBeenCalledTimes(1);
    // The shortcut sends the request rather than adding a line to it.
    expect(request()).toHaveValue('add a login form');
  });

  it('switches between a draft and a scheduled series from the status pills', async () => {
    usePromptBuilderStore.setState({ status: 'draft' });
    const { user } = renderPage();

    const draft = await screen.findByRole('button', { name: 'Draft' });
    const scheduled = screen.getByRole('button', { name: 'Scheduled' });
    expect(draft).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Save draft to project/ })).toBeInTheDocument();

    await user.click(scheduled);

    expect(scheduled).toHaveAttribute('aria-pressed', 'true');
    expect(draft).toHaveAttribute('aria-pressed', 'false');
    expect(usePromptBuilderStore.getState().status).toBe('scheduled');
    expect(screen.getByRole('button', { name: /Add task/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save draft to project/ })).toBeNull();
  });
});
