import { screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { AgentAnswerPanel } from './AgentAnswerPanel';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const QUESTION =
  'I found three nginx sites: default, api.example.com and staging.example.com.\nOnly staging was changed today. Which one should I reload?';

function Harness({ onAnswer }: { onAnswer: (answer: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState('');
  return (
    <AgentAnswerPanel
      question={QUESTION}
      target="ssh"
      draft={draft}
      onDraftChange={setDraft}
      onAnswer={onAnswer}
    />
  );
}

function renderPanel(bridge: Record<string, unknown> = {}) {
  const onAnswer = vi.fn();
  const view = renderWithProviders(<Harness onAnswer={onAnswer} />, {
    bridge: { 'settings.get': { promptBuilderProvider: 'openai', openaiModel: 'm' }, ...bridge },
  });
  const box = () => screen.getByRole('textbox', { name: 'Your answer' });
  return { ...view, onAnswer, box };
}

describe('AgentAnswerPanel', () => {
  it('shows the whole question, line breaks and all', () => {
    renderPanel();
    const question = screen.getByRole('region', { name: 'The AI asks' });
    expect(question).toHaveTextContent(
      'Only staging was changed today. Which one should I reload?',
    );
    expect(question.querySelector('p')?.textContent).toBe(QUESTION);
  });

  it('sends the answer on Enter and clears the box', async () => {
    const { user, onAnswer, box } = renderPanel();
    await user.type(box(), '  staging  {Enter}');
    expect(onAnswer).toHaveBeenCalledWith('staging');
    expect(box()).toHaveValue('');
  });

  it('sends from the Send answer button, which waits for some text', async () => {
    const { user, onAnswer, box } = renderPanel();
    const send = screen.getByRole('button', { name: 'Send answer' });
    expect(send).toBeDisabled();
    await user.type(box(), 'api');
    await user.click(send);
    expect(onAnswer).toHaveBeenCalledWith('api');
  });

  it('never sends a blank answer', async () => {
    const { user, onAnswer, box } = renderPanel();
    await user.type(box(), '   {Enter}');
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('can answer in Persian and translate it first', async () => {
    const { user, onAnswer, box } = renderPanel({
      'translate.text': async () => 'The staging one',
    });
    await user.type(box(), 'اونی که استیجینگه');
    await user.click(screen.getByRole('button', { name: /Translate to English/ }));
    await waitFor(() => expect(box()).toHaveValue('The staging one'));
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(onAnswer).toHaveBeenCalledWith('The staging one');
  });

  it('lets the AI write the answer to this question', async () => {
    const ask = vi.fn(async (_input: { prompt: string }) => ({
      ok: true,
      text: 'Reload staging.example.com.',
    }));
    const { user, box } = renderPanel({ 'ai.ask': ask });
    await user.type(box(), 'staging');
    await user.click(screen.getByRole('button', { name: /Write it for me/ }));
    await waitFor(() => expect(box()).toHaveValue('Reload staging.example.com.'));
    expect(ask.mock.calls[0]?.[0].prompt).toContain('Which one should I reload?');
  });
});
