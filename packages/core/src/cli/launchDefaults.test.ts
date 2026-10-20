import { describe, expect, it } from 'vitest';
import {
  cliLaunchOptions,
  LAUNCH_PICK_CLI_IDS,
  launchDefaultArgs,
  launchDefaultParts,
  launchPickArgs,
  launchPickLabel,
  launchPickOptions,
  normalizeCliLaunchDefaults,
} from './launchDefaults.js';

describe('launchDefaultArgs', () => {
  it('adds nothing when nothing is set', () => {
    expect(launchDefaultArgs('claude-code', undefined)).toEqual([]);
    expect(launchDefaultArgs('claude-code', {})).toEqual([]);
  });

  it('adds only the fields that are set', () => {
    expect(launchDefaultArgs('claude-code', { mode: 'auto' })).toEqual([
      '--permission-mode',
      'auto',
    ]);
    expect(launchDefaultArgs('claude-code', { model: 'opus', effort: 'high' })).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
    ]);
  });

  it('uses each CLI its own flags', () => {
    expect(
      launchDefaultArgs('codex-cli', { model: 'gpt-6-sol', effort: 'xhigh', mode: 'auto' }),
    ).toEqual(['--model', 'gpt-6-sol', '-c', 'model_reasoning_effort=xhigh', '--approve-for-me']);
    expect(launchDefaultArgs('gemini-cli', { mode: 'yolo' })).toEqual(['--approval-mode', 'yolo']);
  });

  it('keeps an effort for Haiku, which takes the same levels as the other Claude models', () => {
    expect(launchDefaultArgs('claude-code', { model: 'haiku', effort: 'high' })).toEqual([
      '--model',
      'haiku',
      '--effort',
      'high',
    ]);
  });

  it('leaves off an effort the chosen model has no setting for', () => {
    expect(launchDefaultArgs('gemini-cli', { model: 'gemini-3.8-flash', effort: 'high' })).toEqual([
      '--model',
      'gemini-3.8-flash',
    ]);
  });

  it('keeps an effort for a model typed by hand', () => {
    expect(launchDefaultArgs('claude-code', { model: 'opus[1m]', effort: 'max' })).toEqual([
      '--model',
      'opus[1m]',
      '--effort',
      'max',
    ]);
  });

  it('never repeats what the launch already sets', () => {
    const taken = ['-m', 'sonnet', '--dangerously-skip-permissions'];
    expect(
      launchDefaultArgs('claude-code', { model: 'opus', effort: 'low', mode: 'plan' }, taken),
    ).toEqual(['--effort', 'low']);
    expect(
      launchDefaultArgs('codex-cli', { effort: 'low' }, ['-c', 'model_reasoning_effort=high']),
    ).toEqual([]);
    const parts = launchDefaultParts('claude-code', { model: 'opus' }, ['--model=haiku']);
    expect(parts).toEqual([{ kind: 'model', args: ['--model', 'opus'], applied: false }]);
  });

  it('sends a saved Grok model and effort, and drops an effort Grok does not have', () => {
    expect(launchDefaultArgs('grok-cli', { model: 'grok-4.7', effort: 'high' })).toEqual([
      '--model',
      'grok-4.7',
      '--reasoning-effort',
      'high',
    ]);
    expect(launchDefaultArgs('grok-cli', { model: 'grok-4.7', effort: 'max' })).toEqual([
      '--model',
      'grok-4.7',
    ]);
  });

  it('keeps an effort for a Grok model typed by hand', () => {
    expect(launchDefaultArgs('grok-cli', { model: 'grok-5', effort: 'low' })).toEqual([
      '--model',
      'grok-5',
      '--reasoning-effort',
      'low',
    ]);
  });

  it('sends a saved Cursor model and never an effort', () => {
    expect(launchDefaultArgs('cursor-cli', { model: 'auto', effort: 'high' })).toEqual([
      '--model',
      'auto',
    ]);
  });

  it('fills in the saved effort when a launch picks only the model', () => {
    expect(
      launchDefaultArgs('claude-code', { model: 'haiku', effort: 'low', mode: 'plan' }, [
        '--model',
        'opus',
      ]),
    ).toEqual(['--effort', 'low', '--permission-mode', 'plan']);
  });

  it('ignores a mode the CLI does not have', () => {
    expect(launchDefaultArgs('claude-code', { mode: 'yolo' })).toEqual([]);
  });
});

describe('cliLaunchOptions', () => {
  it('lists known models and modes', () => {
    const claude = cliLaunchOptions('claude-code');
    expect(claude?.models.map((m) => m.value)).toContain('opus');
    expect(claude?.modes.map((m) => m.id)).toContain('auto');
  });

  it('returns null for unknown CLIs', () => {
    expect(cliLaunchOptions('nope')).toBeNull();
  });

  it('lists Grok and Cursor models, with effort only for Grok', () => {
    const grok = cliLaunchOptions('grok-cli');
    expect(grok?.models.map((m) => m.value)).toContain('grok-4.7');
    expect(grok?.models.every((m) => m.efforts?.includes('high'))).toBe(true);
    const cursor = cliLaunchOptions('cursor-cli');
    expect(cursor?.models.map((m) => m.value)).toEqual([
      'auto',
      'composer-2.5',
      'claude-fable-5-1-high',
      'claude-opus-5-5-high',
      'claude-sonnet-5-5-high',
      'claude-haiku-5-5-thinking-high',
      'gpt-5.6-sol-high',
      'gemini-4-argon-high',
      'gemini-3.8-flash-high',
      'grok-4.7-high',
    ]);
    expect(cursor?.efforts).toEqual([]);
  });
});

describe('launchPickOptions', () => {
  it('offers a picker for these five CLIs only', () => {
    expect([...LAUNCH_PICK_CLI_IDS].sort()).toEqual([
      'claude-code',
      'codex-cli',
      'cursor-cli',
      'gemini-cli',
      'grok-cli',
    ]);
    for (const id of LAUNCH_PICK_CLI_IDS) {
      expect(launchPickOptions(id), id).not.toBeNull();
    }
    expect(launchPickOptions('copilot-cli')).toBeNull();
    expect(launchPickOptions('nope')).toBeNull();
  });

  it('lists the Gemini models with a tier and a cost, and no effort', () => {
    const models = launchPickOptions('gemini-cli')!.models;
    expect(models.map((m) => m.label)).toEqual([
      'Gemini 3.5 Flash-Lite',
      'Gemini 3.8 Flash',
      'Gemini 3.1 Pro',
      'Gemini 4 Argon',
    ]);
    expect(models.map((m) => m.tier)).toEqual(['Fast', 'Balanced', 'Deep', 'Frontier']);
    const [lite, flash, pro, argon] = models.map((m) => m.costLevel!);
    expect(lite).toBeLessThan(flash!);
    expect(flash).toBeLessThan(pro!);
    expect(pro).toBeLessThan(argon!);
    for (const model of models) {
      expect(model.efforts, model.label).toBeUndefined();
      expect(model.effortCost, model.label).toBeUndefined();
    }
  });

  it('adds a tier and cost levels where the CLI has a run profile', () => {
    const claude = launchPickOptions('claude-code')!;
    const haiku = claude.models.find((m) => m.value === 'haiku')!;
    const fable = claude.models.find((m) => m.value === 'fable')!;
    expect(haiku.tier).toBe('Fast');
    expect(fable.tier).toBe('Frontier');
    expect(fable.costLevel!).toBeGreaterThan(haiku.costLevel!);
    const cost = fable.effortCost!;
    expect(cost.max!).toBeGreaterThan(cost.low!);
    expect(Object.keys(cost)).toEqual(fable.efforts);
  });

  it('has no tier or cost for Grok and Cursor', () => {
    for (const id of ['grok-cli', 'cursor-cli']) {
      for (const model of launchPickOptions(id)!.models) {
        expect(model.tier, id).toBeUndefined();
        expect(model.costLevel, id).toBeUndefined();
        expect(model.effortCost, id).toBeUndefined();
      }
    }
  });
});

describe('launchPickArgs', () => {
  it('sets the model, and the effort when it fits', () => {
    expect(launchPickArgs('claude-code', { model: 'opus' })).toEqual(['--model', 'opus']);
    expect(launchPickArgs('claude-code', { model: 'opus', effort: 'high' })).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
    ]);
  });

  it('uses each CLI its own effort flag', () => {
    expect(launchPickArgs('codex-cli', { model: 'gpt-6-sol', effort: 'xhigh' })).toEqual([
      '--model',
      'gpt-6-sol',
      '-c',
      'model_reasoning_effort=xhigh',
    ]);
    expect(launchPickArgs('grok-cli', { model: 'grok-4.7', effort: 'low' })).toEqual([
      '--model',
      'grok-4.7',
      '--reasoning-effort',
      'low',
    ]);
  });

  it('leaves off an effort the model or the CLI cannot take', () => {
    expect(launchPickArgs('grok-cli', { model: 'grok-4.7', effort: 'max' })).toEqual([
      '--model',
      'grok-4.7',
    ]);
    expect(launchPickArgs('cursor-cli', { model: 'auto', effort: 'high' })).toEqual([
      '--model',
      'auto',
    ]);
    // Gemini has no per-run effort flag at all.
    expect(launchPickArgs('gemini-cli', { model: 'gemini-3.8-flash', effort: 'high' })).toEqual([
      '--model',
      'gemini-3.8-flash',
    ]);
  });

  it('adds nothing without a model or for an unknown CLI', () => {
    expect(launchPickArgs('claude-code', { effort: 'high' })).toEqual([]);
    expect(launchPickArgs('claude-code', {})).toEqual([]);
    expect(launchPickArgs('nope', { model: 'x' })).toEqual([]);
  });
});

describe('launchPickLabel', () => {
  it('names the model and the effort that applies', () => {
    expect(launchPickLabel('claude-code', { model: 'opus', effort: 'high' })).toBe(
      'Opus 5.5 · High',
    );
    expect(launchPickLabel('claude-code', { model: 'opus' })).toBe('Opus 5.5');
    expect(launchPickLabel('cursor-cli', { model: 'auto', effort: 'high' })).toBe('Auto');
    expect(launchPickLabel('gemini-cli', { model: 'gemini-3.1-pro-preview' })).toBe(
      'Gemini 3.1 Pro',
    );
  });

  it('shows a model typed by hand as it is, and a bare effort as an effort', () => {
    expect(launchPickLabel('claude-code', { model: 'opus[1m]' })).toBe('opus[1m]');
    expect(launchPickLabel('claude-code', { effort: 'xhigh' })).toBe('Extra high effort');
    expect(launchPickLabel('claude-code', {})).toBeUndefined();
    expect(launchPickLabel('nope', { model: 'x' })).toBeUndefined();
  });
});

describe('normalizeCliLaunchDefaults', () => {
  it('drops junk and empty entries', () => {
    expect(
      normalizeCliLaunchDefaults({
        'claude-code': { model: ' opus ', effort: 'turbo', mode: 'auto' },
        'codex-cli': { model: '', effort: null },
        broken: 'x',
      }),
    ).toEqual({ 'claude-code': { model: 'opus', mode: 'auto' } });
    expect(normalizeCliLaunchDefaults(null)).toEqual({});
  });
});
