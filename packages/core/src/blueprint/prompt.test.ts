import { describe, expect, it } from 'vitest';
import {
  type BlueprintPromptInput,
  buildBlueprintGenerationRequest,
  buildBlueprintPrompt,
} from './prompt.js';

function input(overrides: Partial<BlueprintPromptInput> = {}): BlueprintPromptInput {
  return {
    projectName: 'CuraLink',
    agentLabel: 'Claude Code',
    targetAI: 'Claude Code',
    docsFolder: 'docs',
    sections: [{ stepId: 'idea', text: 'A clinic portal.', attachmentNames: [] }],
    confirmBeforeWriting: false,
    ...overrides,
  };
}

describe('buildBlueprintPrompt', () => {
  it('asks for a backlog when the relay is off', () => {
    const prompt = buildBlueprintPrompt(input());
    expect(prompt).toContain('docs/BACKLOG.md');
    expect(prompt).not.toContain('docs/tasks/');
  });

  it('asks for Relay task files instead of a backlog when the relay is on', () => {
    const prompt = buildBlueprintPrompt(input({ relay: { enabled: true, budgetTokens: 200_000 } }));
    expect(prompt).not.toContain('BACKLOG.md');
    expect(prompt).toContain('docs/tasks/');
    expect(prompt).toContain('docs/tasks/RELAY.md');
    expect(prompt).toContain('200K');
  });
});

describe('buildBlueprintGenerationRequest', () => {
  it('passes the relay instructions on to the prompt it asks for', () => {
    const request = buildBlueprintGenerationRequest(
      input({ relay: { enabled: true, budgetTokens: 400_000 } }),
    );
    expect(request).not.toContain('BACKLOG.md');
    expect(request).toContain('docs/tasks/');
    expect(request).toContain('400K');
  });

  it('keeps the backlog when the relay is off', () => {
    expect(buildBlueprintGenerationRequest(input())).toContain('docs/BACKLOG.md');
  });
});
