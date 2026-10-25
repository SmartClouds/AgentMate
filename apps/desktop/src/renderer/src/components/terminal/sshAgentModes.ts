import type { SshAgentMode } from '@shared/apiTypes';

/** The ways an AI terminal task can run, from asking about every command to none. */
export const SSH_AGENT_MODES: { value: SshAgentMode; label: string; description: string }[] = [
  {
    value: 'approve-all',
    label: 'Approve each command',
    description: 'Nothing runs until you click Run on it.',
  },
  {
    value: 'approve-risky',
    label: 'Auto, guard risky ones',
    description: 'Ordinary commands run right away; destructive-looking ones pause for you.',
  },
  {
    value: 'autonomous',
    label: 'Fully autonomous',
    description: 'Runs the whole task unattended. Just watch the terminal.',
  },
];
