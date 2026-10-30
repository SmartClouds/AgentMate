import type { SshAgentHistoryRun, SshAgentProgress } from '@shared/apiTypes';
import type {
  AssistantMessage,
  AssistantRun,
  AssistantStep,
  AssistantTurn,
} from '@/stores/deployAssistantStore';

/**
 * A past chat from the history, as the drawer shows a chat: each of its runs as a turn with the
 * user's question, the steps with their output, what was said along the way and how it ended.
 * The newest run is the one on screen and the rest sit above it, as after a follow-up.
 */

const NOT_ENDED = 'This run did not end. Runova may have closed while it was going.';

/** The history keeps a command's output as one text; the timeline shows it line by line. */
function outputLines(output: string): AssistantStep['lines'] {
  const text = output.replace(/\n$/, '');
  return text ? text.split('\n').map((line) => ({ stream: 'out', text: line })) : [];
}

function turnFrom(run: SshAgentHistoryRun): AssistantTurn {
  const steps: AssistantStep[] = [];
  const messages: AssistantMessage[] = [];
  let ended: { phase: SshAgentProgress['phase']; message: string } | null = null;
  let lastError = '';
  for (const entry of run.entries) {
    switch (entry.kind) {
      case 'command':
        steps.push({
          step: steps.length + 1,
          command: entry.command,
          status: 'done',
          lines: outputLines(entry.output),
        });
        break;
      case 'skipped':
        steps.push({
          step: steps.length + 1,
          command: entry.command,
          status: 'skipped',
          lines: [],
        });
        break;
      case 'message':
      case 'answer':
        messages.push({ text: entry.text, at: steps.length });
        break;
      case 'question':
        messages.push({ text: entry.text, at: steps.length, from: 'ai' });
        break;
      case 'error':
        lastError = entry.text;
        break;
      case 'finished':
        ended = { phase: 'finished', message: entry.text };
        break;
      case 'stopped':
        ended = { phase: 'stopped', message: entry.text };
        break;
      case 'continued':
        break;
    }
  }
  if (!ended) {
    ended =
      run.status === 'error'
        ? { phase: 'error', message: lastError }
        : { phase: 'stopped', message: NOT_ENDED };
  }
  return {
    prompt: run.prompt,
    steps,
    messages,
    progress: { sessionId: run.sessionId, step: steps.length, ...ended },
  };
}

/** The runs of a chat, oldest first, as the drawer's run with the earlier ones above it. */
export function runFromChain(chain: readonly SshAgentHistoryRun[]): AssistantRun {
  const turns = chain.map(turnFrom);
  const latest = turns.at(-1) ?? { progress: null, steps: [], messages: [] };
  const app = [...chain].reverse().find((run) => run.app)?.app;
  return { ...latest, earlier: turns.slice(0, -1), ...(app ? { app } : {}) };
}
