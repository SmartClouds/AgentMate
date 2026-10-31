/**
 * The longest message the user can send an AI task that is already running. The composer stops
 * typing here, and the main process cuts anything longer that still gets through.
 */
export const MAX_SSH_AGENT_MESSAGE_CHARS = 50_000;
