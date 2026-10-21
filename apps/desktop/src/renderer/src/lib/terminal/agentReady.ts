/**
 * When a freshly started agent CLI can be typed into. The rule lives in core so main can apply it
 * too: Relay legs start without a tab on screen and get their prompt from the main process.
 */
export {
  AGENT_READY_TIMING,
  type AgentReadySignals,
  type AgentReadyVerdict,
  agentReadyVerdict,
} from '@agentmat/core';
