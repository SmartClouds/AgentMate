/** What the text in an AI task box is for: starting a task, a note mid-run, or an answer to it. */
export type AgentInstructionPurpose = 'task' | 'message' | 'answer';

/** Where the agent that reads the instruction works. */
export type AgentInstructionTarget = 'ssh' | 'local' | 'rdp';

export interface AgentInstructionInput {
  /** What the user typed or dictated, in any language. */
  text: string;
  purpose: AgentInstructionPurpose;
  target: AgentInstructionTarget;
  /** The agent's question, when `purpose` is `answer`. */
  question?: string;
}

const TARGETS: Record<AgentInstructionTarget, string> = {
  ssh: 'a remote server over SSH, running one shell command at a time',
  local: "a shell on the user's own computer, running one command at a time",
  rdp: 'a Remote Desktop session, using the mouse and keyboard',
};

const PURPOSES: Record<AgentInstructionPurpose, string> = {
  task: 'Rewrite it as the task the user wants done: say what to check or change and what counts as done.',
  message:
    'The agent is already working on a task. Rewrite this as a short message to it: a correction, a limit, or something to do next.',
  answer: 'Rewrite this as a direct answer to the question, nothing more.',
};

/**
 * The request "Write it for me" sends to the user's AI provider, so it turns a rough note into the
 * instruction an AI agent reads. Only the user's text and the agent's question go in verbatim.
 */
export function buildAgentInstructionRequest({
  text,
  purpose,
  target,
  question,
}: AgentInstructionInput): string {
  const asked =
    purpose === 'answer' && question?.trim()
      ? `\nThe agent asked:\n"""\n${question.trim()}\n"""\n`
      : '';

  return `You help a user talk to an AI agent that operates ${TARGETS[target]}. The user wrote a rough note, possibly in another language such as Persian, possibly incomplete.
${asked}
The user's note:
"""
${text.trim()}
"""

${PURPOSES[purpose]} Write it in clear English, in one to three sentences. Keep commands, file paths, host names, package names and numbers verbatim. Do not add steps or requirements the user did not ask for. Output ONLY the rewritten text, with no preamble, quotes, or commentary.`;
}
