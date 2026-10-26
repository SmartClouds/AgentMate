import type { AppSettings } from '@runova/core';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonacoEditorProps } from '@/components/editor/MonacoEditor';
import { usePromptBuilderStore } from '@/stores/promptBuilderStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/** The Prompt Builder hands its prompt to Relay, with the project picked in the dialog. */

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  Toaster: () => null,
}));
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
  speechLanguage: 'en',
} as AppSettings;

function renderPage() {
  return renderWithProviders(<PromptBuilderPage />, {
    route: '/prompt-builder',
    bridge: {
      'settings.get': settings,
      'projects.list': [{ id: 'p1', name: 'Apollo', folderPath: '/w', agentType: 'claude-code' }],
    },
  });
}

beforeEach(() => {
  usePromptBuilderStore.setState({ rawInput: '', generated: '', projectId: null });
});

describe('Prompt Builder, Split into tasks', () => {
  it('opens the split with the generated prompt and a project to pick', async () => {
    usePromptBuilderStore.setState({ rawInput: 'search page', generated: '# Search\nBuild it.' });
    const { user } = renderPage();

    await user.click(screen.getByRole('button', { name: 'Split into tasks' }));

    const dialog = await screen.findByRole('dialog', { name: 'Split into tasks' });
    expect(
      within(dialog).getByRole('textbox', { name: 'What should the tasks deliver?' }),
    ).toHaveValue('# Search\nBuild it.');
    expect(within(dialog).getByRole('combobox', { name: 'Project' })).toBeInTheDocument();
  });

  it('is off until there is something to split', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Split into tasks' })).toBeDisabled();
  });
});
