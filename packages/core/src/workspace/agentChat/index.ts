import { applyClaudeLines } from './claude.js';
import { applyCodexLines } from './codex.js';
import { applyGeminiLines } from './gemini.js';
import type { ChatReader } from './types.js';

export * from './types.js';
export { applyClaudeLines, applyCodexLines, applyGeminiLines };

const READERS: Record<string, ChatReader> = {
  'claude-code': applyClaudeLines,
  openclaude: applyClaudeLines,
  'codex-cli': applyCodexLines,
  'gemini-cli': applyGeminiLines,
  'qwen-cli': applyGeminiLines,
};

/** CLIs whose Workspace tabs can switch to the chat view. */
export const CHAT_SUPPORTED_CLIS: readonly string[] = Object.keys(READERS);

export function chatReaderFor(cliId: string | undefined | null): ChatReader | null {
  return (cliId && READERS[cliId]) || null;
}
