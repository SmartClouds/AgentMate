import { describe, expect, it } from 'vitest';
import { CLI_REGISTRY } from '../../cli/registry.js';
import { CHAT_SUPPORTED_CLIS, chatReaderFor, emptyChatState } from './index.js';

describe('chat readers', () => {
  it('has a reader for every CLI it says it supports, and they are all real CLIs', () => {
    const ids = CLI_REGISTRY.map((cli) => cli.id);
    for (const cliId of CHAT_SUPPORTED_CLIS) {
      expect(ids).toContain(cliId);
      expect(chatReaderFor(cliId)).not.toBeNull();
    }
  });

  it('covers Claude Code, Codex and Gemini and the CLIs that share their transcripts', () => {
    expect([...CHAT_SUPPORTED_CLIS].sort()).toEqual(
      ['claude-code', 'codex-cli', 'gemini-cli', 'openclaude', 'qwen-cli'].sort(),
    );
  });

  it('has no reader for other CLIs or a plain shell', () => {
    expect(chatReaderFor('aider')).toBeNull();
    expect(chatReaderFor(undefined)).toBeNull();
  });

  it('reads with the reader for the CLI it is given', () => {
    const reader = chatReaderFor('claude-code');
    const state = reader?.(emptyChatState(), [
      JSON.stringify({ type: 'user', uuid: 'u', message: { content: 'hi' } }),
    ]);
    expect(state?.items).toEqual([expect.objectContaining({ kind: 'user', text: 'hi' })]);
  });
});
