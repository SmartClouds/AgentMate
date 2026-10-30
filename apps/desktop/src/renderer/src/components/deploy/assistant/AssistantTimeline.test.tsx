import type { SshAgentProgress } from '@shared/apiTypes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantStep, AssistantTurn } from '@/stores/deployAssistantStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { AssistantTimeline } from './AssistantTimeline';

const LONG_TOKEN = `/var/lib/docker/overlay2/${'a1b2c3d4'.repeat(40)}/merged`;

function progress(phase: SshAgentProgress['phase'], extra: Partial<SshAgentProgress> = {}) {
  return { sessionId: 'deploy:srv-1', phase, step: 1, ...extra } as SshAgentProgress;
}

const step: AssistantStep = {
  step: 1,
  command: 'docker ps -a',
  status: 'done',
  lines: [
    { stream: 'out', text: 'CONTAINER ID   IMAGE' },
    { stream: 'out', text: '1a2b3c4d5e6f   nginx' },
  ],
};

function renderTimeline(props: Partial<Parameters<typeof AssistantTimeline>[0]> = {}) {
  return renderWithProviders(
    <AssistantTimeline
      steps={[]}
      progress={null}
      onApprove={vi.fn()}
      onSkip={vi.fn()}
      onAnswer={vi.fn()}
      onResume={vi.fn()}
      onStop={vi.fn()}
      {...props}
    />,
  );
}

describe('copying', () => {
  it('puts a copy action under every message, earlier turns included', async () => {
    const earlier: AssistantTurn[] = [
      {
        prompt: 'What runs here?',
        steps: [],
        messages: [],
        progress: progress('finished', { message: 'Two services: web and db.' }),
      },
    ];
    const { user } = renderTimeline({
      earlier,
      prompt: 'Why is web slow?',
      messages: [{ text: 'Leave db alone.', at: 0 }],
      steps: [step],
      progress: progress('needs-input', { message: 'Which domain?' }),
    });

    const copies = screen.getAllByRole('button', { name: 'Copy message' });
    // Two questions, a message, an answer and the AI's question.
    expect(copies).toHaveLength(5);

    const answer = screen.getByRole('article', { name: 'AI answer' });
    await user.click(within(answer).getByRole('button', { name: 'Copy message' }));
    expect(await navigator.clipboard.readText()).toBe('Two services: web and db.');

    const asked = screen.getAllByLabelText('You asked')[1] as HTMLElement;
    await user.click(within(asked).getByRole('button', { name: 'Copy message' }));
    expect(await navigator.clipboard.readText()).toBe('Why is web slow?');
  });

  it('copies a step’s command and its output', async () => {
    const { user } = renderTimeline({ steps: [step], progress: progress('thinking') });
    const item = screen.getByRole('listitem', { name: 'Step 1: docker ps -a' });
    await user.click(within(item).getByRole('button', { name: 'Copy command' }));
    expect(await navigator.clipboard.readText()).toBe('docker ps -a');
    await user.click(within(item).getByRole('button', { name: 'Copy output' }));
    expect(await navigator.clipboard.readText()).toBe('CONTAINER ID   IMAGE\n1a2b3c4d5e6f   nginx');
  });

  it('has no output to copy before a step printed anything', () => {
    renderTimeline({ steps: [{ ...step, lines: [] }], progress: progress('thinking') });
    expect(screen.queryByRole('button', { name: 'Copy output' })).not.toBeInTheDocument();
  });

  it('keeps the latest answer’s copy action in view, and earlier ones quiet', () => {
    renderTimeline({
      earlier: [
        { prompt: 'a', steps: [], messages: [], progress: progress('finished', { message: 'x' }) },
      ],
      prompt: 'b',
      progress: progress('finished', { message: 'y' }),
    });
    const [old, latest] = screen.getAllByRole('article', { name: 'AI answer' });
    expect(within(old as HTMLElement).getByRole('button', { name: 'Copy message' })).toHaveClass(
      'opacity-0',
    );
    expect(
      within(latest as HTMLElement).getByRole('button', { name: 'Copy message' }),
    ).not.toHaveClass('opacity-0');
  });
});

describe('answers', () => {
  it('shows a full answer as Markdown, with lists and code', () => {
    renderTimeline({
      prompt: 'What does it expose?',
      progress: progress('finished', {
        message: 'It exposes:\n\n- port 80\n- port 443\n\n```sh\ndocker ps\n```',
      }),
    });
    const answer = screen.getByRole('article', { name: 'AI answer' });
    expect(within(answer).getAllByRole('listitem')).toHaveLength(2);
    expect(within(answer).getByText('docker ps')).toBeInTheDocument();
    expect(within(answer).getByText('It exposes:')).toBeInTheDocument();
  });

  it('shows a question the AI asked on its own side, apart from what the user said', () => {
    renderTimeline({
      earlier: [
        {
          prompt: 'Check a site',
          steps: [],
          messages: [
            { text: 'Which site?', at: 0, from: 'ai' },
            { text: 'shop.example.com', at: 0 },
          ],
          progress: progress('finished', { message: 'ok' }),
        },
      ],
    });
    expect(screen.getByRole('listitem', { name: 'The AI asked' })).toHaveTextContent('Which site?');
    expect(screen.getByRole('listitem', { name: 'You said' })).toHaveTextContent(
      'shop.example.com',
    );
  });

  it('says when the run was stopped', () => {
    renderTimeline({ progress: progress('stopped', { message: 'Stopped by user.' }) });
    expect(screen.getByText('Stopped by user.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
  });
});

describe('long text never widens the drawer', () => {
  const WRAPS = '[overflow-wrap:anywhere]';

  it('wraps a long token in an answer, a stop, an error, an approval and a question', () => {
    const { unmount } = renderTimeline({
      earlier: [
        { steps: [], messages: [], progress: progress('error', { message: LONG_TOKEN }) },
        { steps: [], messages: [], progress: progress('stopped', { message: LONG_TOKEN }) },
      ],
      progress: progress('finished', { message: LONG_TOKEN }),
    });
    for (const text of screen.getAllByText(LONG_TOKEN)) {
      expect(text.closest(`[class*="${WRAPS}"]`)).not.toBeNull();
    }
    unmount();

    for (const phase of ['proposed', 'needs-input', 'error'] as const) {
      const { unmount: done } = renderTimeline({
        progress: progress(phase, { message: LONG_TOKEN, command: 'ls' }),
      });
      expect(screen.getByText(LONG_TOKEN).closest(`[class*="${WRAPS}"]`)).not.toBeNull();
      done();
    }
  });
});
