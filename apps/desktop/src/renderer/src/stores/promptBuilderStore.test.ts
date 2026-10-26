import { DEFAULT_TARGET_AI, getCliDefinition } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePromptBuilderStore } from './promptBuilderStore';

function state() {
  return usePromptBuilderStore.getState();
}

beforeEach(() => {
  usePromptBuilderStore.setState({
    rawInput: '',
    promptType: 'Full Stack',
    targetAI: DEFAULT_TARGET_AI,
    generated: '',
    targetLang: 'en',
    projectId: null,
    status: 'draft',
  });
});

describe('the initial state', () => {
  it('starts as an empty draft aimed at the default agent', () => {
    expect(state()).toMatchObject({
      rawInput: '',
      promptType: 'Full Stack',
      targetAI: DEFAULT_TARGET_AI,
      generated: '',
      targetLang: 'en',
      projectId: null,
      status: 'draft',
    });
  });
});

describe('the setters', () => {
  it('each change exactly one field', () => {
    state().setRawInput('add a login page');
    state().setPromptType('Frontend');
    state().setGenerated('# Task');
    state().setTargetLang('fa');
    state().setProjectId('p1');
    state().setStatus('scheduled');
    expect(state()).toMatchObject({
      rawInput: 'add a login page',
      promptType: 'Frontend',
      generated: '# Task',
      targetLang: 'fa',
      projectId: 'p1',
      status: 'scheduled',
    });
  });

  it('can point the form at another agent, and back at no project', () => {
    state().setTargetAI('codex');
    expect(state().targetAI).toBe('codex');
    state().setProjectId('p1');
    state().setProjectId(null);
    expect(state().projectId).toBeNull();
  });
});

describe('coming back from a saved draft', () => {
  function seed(saved: Record<string, unknown>): void {
    localStorage.setItem('runova-prompt-builder', JSON.stringify({ state: saved, version: 0 }));
  }

  it('restores the draft as it was left', async () => {
    seed({
      rawInput: 'half written',
      promptType: 'Backend',
      generated: '# Task',
      targetLang: 'fa',
    });
    await usePromptBuilderStore.persist.rehydrate();
    expect(state()).toMatchObject({
      rawInput: 'half written',
      promptType: 'Backend',
      generated: '# Task',
      targetLang: 'fa',
    });
  });

  it('maps a legacy agent name onto today is label', async () => {
    // Older builds stored "Claude", which no longer matches anything in the CLI registry.
    seed({ targetAI: 'Claude' });
    await usePromptBuilderStore.persist.rehydrate();
    expect(state().targetAI).toBe('Claude Code');
  });

  it('maps a saved CLI id onto its label', async () => {
    // The prompt targets the short label ("Codex"), not the CLI's full name ("Codex CLI"), and
    // the registry is the only place either one is defined.
    const label = getCliDefinition('codex-cli')?.label;
    seed({ targetAI: 'codex-cli' });
    await usePromptBuilderStore.persist.rehydrate();
    expect(state().targetAI).toBe(label);
  });

  it('falls back to the default agent when none was saved', async () => {
    seed({ rawInput: 'x' });
    await usePromptBuilderStore.persist.rehydrate();
    expect(state().targetAI).toBe(DEFAULT_TARGET_AI);
  });

  it('keeps the actions callable after a rehydrate', async () => {
    seed({ rawInput: 'x' });
    await usePromptBuilderStore.persist.rehydrate();
    state().setRawInput('y');
    expect(state().rawInput).toBe('y');
  });

  it('saves the draft as it is typed', () => {
    state().setRawInput('typing');
    const saved = JSON.parse(localStorage.getItem('runova-prompt-builder') ?? '{}');
    expect(saved.state.rawInput).toBe('typing');
  });
});
