import { beforeEach, describe, expect, it } from 'vitest';
import { type KeyEventLike, SHORTCUT_COMMANDS, type Shortcut } from '@/lib/shortcuts';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import {
  bindingsFor,
  commandForEvent,
  conflictingCommand,
  useShortcutStore,
} from './shortcutStore';

function press(fields: Partial<KeyEventLike>): KeyEventLike {
  return {
    code: '',
    key: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...fields,
  };
}

function defaultsOf(id: string): Shortcut[] {
  const command = SHORTCUT_COMMANDS.find((one) => one.id === id);
  if (!command) throw new Error(`${id} is missing from the registry`);
  return command.defaults;
}

function overrides() {
  return useShortcutStore.getState().overrides;
}

beforeEach(() => {
  installRunovaBridge({ platform: 'win32' });
  useShortcutStore.setState({ overrides: {} });
});

describe('the initial state', () => {
  it('has no overrides, so every command uses its registry default', () => {
    expect(overrides()).toEqual({});
    expect(bindingsFor('terminal.toggle', {})).toEqual(defaultsOf('terminal.toggle'));
  });
});

describe('setBindings, resetCommand and resetAll', () => {
  it('keeps only the commands the user actually changed', () => {
    // Anything absent falls back to the registry, so later default changes still reach users
    // instead of being frozen into their saved copy.
    useShortcutStore.getState().setBindings('nav.projects', [{ code: 'KeyJ', mod: true }]);
    expect(overrides()).toEqual({ 'nav.projects': [{ code: 'KeyJ', mod: true }] });
    expect(bindingsFor('nav.projects', overrides())).toEqual([{ code: 'KeyJ', mod: true }]);
    expect(bindingsFor('search.toggle', overrides())).toEqual(defaultsOf('search.toggle'));
  });

  it('can leave a command with no binding at all', () => {
    useShortcutStore.getState().setBindings('nav.projects', []);
    expect(bindingsFor('nav.projects', overrides())).toEqual([]);
  });

  it('puts one command back on its default', () => {
    useShortcutStore.getState().setBindings('nav.projects', [{ code: 'KeyJ', mod: true }]);
    useShortcutStore.getState().setBindings('search.toggle', [{ code: 'KeyO', mod: true }]);
    useShortcutStore.getState().resetCommand('nav.projects');
    expect(overrides()).toEqual({ 'search.toggle': [{ code: 'KeyO', mod: true }] });
    expect(bindingsFor('nav.projects', overrides())).toEqual(defaultsOf('nav.projects'));
  });

  it('does not mind resetting a command that was never changed', () => {
    useShortcutStore.getState().resetCommand('nav.projects');
    expect(overrides()).toEqual({});
  });

  it('puts everything back at once', () => {
    useShortcutStore.getState().setBindings('nav.projects', [{ code: 'KeyJ', mod: true }]);
    useShortcutStore.getState().setBindings('vault.lock', [{ code: 'KeyQ', mod: true }]);
    useShortcutStore.getState().resetAll();
    expect(overrides()).toEqual({});
  });
});

describe('commandForEvent', () => {
  it('finds the app-wide command a keypress triggers', () => {
    expect(commandForEvent(press({ code: 'KeyK', key: 'k', ctrlKey: true }), {})).toBe(
      'search.toggle',
    );
  });

  it('matches a second binding of the same command', () => {
    // Toggle terminal ships as both Ctrl+T and Ctrl+`.
    expect(commandForEvent(press({ code: 'Backquote', key: '`', ctrlKey: true }), {})).toBe(
      'terminal.toggle',
    );
  });

  it('finds nothing for a key nothing is bound to', () => {
    expect(commandForEvent(press({ code: 'KeyZ', key: 'z', ctrlKey: true }), {})).toBeNull();
  });

  it('gives Ctrl+P to the workspace search on the workspace, and to Projects elsewhere', () => {
    const event = press({ code: 'KeyP', key: 'p', ctrlKey: true });
    expect(commandForEvent(event, {}, true, 'workspace')).toBe('workspace.search');
    expect(commandForEvent(event, {}, true, 'global')).toBe('nav.projects');
    expect(conflictingCommand({ code: 'KeyP', mod: true }, 'workspace.search', {})).toBeNull();
  });

  it('only looks in the scope it was asked about', () => {
    // Ctrl+T means translate in the prompt builder and toggle terminal everywhere else.
    const event = press({ code: 'KeyT', key: 't', ctrlKey: true });
    expect(commandForEvent(event, {}, false, 'prompt')).toBe('prompt.translate');
    expect(commandForEvent(event, {}, false, 'global')).toBe('terminal.toggle');
    expect(commandForEvent(event, {}, false, 'workspace')).toBeNull();
  });

  it('uses the user is binding rather than the default', () => {
    const custom = { 'search.toggle': [{ code: 'KeyO', mod: true }] };
    expect(commandForEvent(press({ code: 'KeyO', key: 'o', ctrlKey: true }), custom)).toBe(
      'search.toggle',
    );
    expect(commandForEvent(press({ code: 'KeyK', key: 'k', ctrlKey: true }), custom)).toBeNull();
  });

  it('ignores a plain letter binding while the user is typing into a field', () => {
    // Such a binding cannot be entered through the settings page, but one saved by an older
    // build would otherwise swallow that letter in every text box.
    const custom = { 'vault.new': [{ code: 'KeyN' }] };
    const event = press({ code: 'KeyN', key: 'n' });
    expect(commandForEvent(event, custom, false, 'vault')).toBe('vault.new');
    expect(commandForEvent(event, custom, true, 'vault')).toBeNull();
  });

  it('still fires a function key while typing, since it types nothing itself', () => {
    const event = press({ code: 'F7', key: 'F7' });
    expect(commandForEvent(event, {}, true, 'workspace')).toBe('workspace.nextChange');
  });

  it('still fires a binding with a modifier while typing', () => {
    expect(commandForEvent(press({ code: 'KeyK', key: 'k', ctrlKey: true }), {}, true)).toBe(
      'search.toggle',
    );
  });

  it('matches any digit for the go-to-tab command', () => {
    for (const digit of ['Digit1', 'Digit5', 'Digit9']) {
      expect(
        commandForEvent(
          press({ code: digit, key: digit.slice(5), altKey: true }),
          {},
          false,
          'workspace',
        ),
      ).toBe('workspace.goToTab');
    }
  });

  it('opens agents on Ctrl and a digit, leaving Alt and a digit to the tabs', () => {
    for (const digit of ['Digit1', 'Digit5', 'Digit9']) {
      expect(
        commandForEvent(
          press({ code: digit, key: digit.slice(5), ctrlKey: true }),
          {},
          false,
          'workspace',
        ),
      ).toBe('workspace.launchAgent');
    }
  });

  it('builds a prompt on Ctrl+G in the workspace, whatever the layout', () => {
    expect(
      commandForEvent(press({ code: 'KeyG', key: 'گ', ctrlKey: true }), {}, true, 'workspace'),
    ).toBe('workspace.buildPrompt');
    // Ctrl+Shift+G is still the changes panel.
    expect(
      commandForEvent(
        press({ code: 'KeyG', key: 'G', ctrlKey: true, shiftKey: true }),
        {},
        true,
        'workspace',
      ),
    ).toBe('workspace.toggleGitPanel');
  });

  it('matches the physical key on a non-Latin layout', () => {
    // On a Farsi layout this key types "ف", and Ctrl+T still has to toggle the terminal.
    expect(commandForEvent(press({ code: 'KeyT', key: 'ف', ctrlKey: true }), {})).toBe(
      'terminal.toggle',
    );
  });
});

describe('conflictingCommand', () => {
  it('finds the command already using a binding', () => {
    const taken = conflictingCommand({ code: 'KeyK', mod: true }, 'nav.projects', {});
    expect(taken?.id).toBe('search.toggle');
  });

  it('finds nothing for a free binding', () => {
    expect(
      conflictingCommand({ code: 'KeyZ', mod: true, alt: true }, 'nav.projects', {}),
    ).toBeNull();
  });

  it('never reports a command against itself', () => {
    expect(conflictingCommand({ code: 'KeyK', mod: true }, 'search.toggle', {})).toBeNull();
  });

  it('lets another scope reuse the same combination', () => {
    // The prompt builder is free to reuse a combination the shell also listens for.
    expect(conflictingCommand({ code: 'KeyT', mod: true }, 'prompt.translate', {})).toBeNull();
    expect(conflictingCommand({ code: 'KeyT', mod: true }, 'nav.projects', {})?.id).toBe(
      'terminal.toggle',
    );
  });

  it('checks against the user is bindings, not the shipped ones', () => {
    const custom = { 'search.toggle': [{ code: 'KeyO', mod: true }] };
    expect(conflictingCommand({ code: 'KeyK', mod: true }, 'nav.projects', custom)).toBeNull();
    expect(conflictingCommand({ code: 'KeyO', mod: true }, 'nav.projects', custom)?.id).toBe(
      'search.toggle',
    );
  });

  it('treats a number-row binding as owning every digit', () => {
    // Open agent is stored as Ctrl+1 but answers to Ctrl+1 through Ctrl+9.
    expect(conflictingCommand({ code: 'Digit4', mod: true }, 'workspace.newTab', {})?.id).toBe(
      'workspace.launchAgent',
    );
    expect(conflictingCommand({ code: 'Digit4', alt: true }, 'workspace.newTab', {})?.id).toBe(
      'workspace.goToTab',
    );
  });

  it('does not clash a number-row binding with a letter', () => {
    expect(conflictingCommand({ code: 'KeyY', mod: true }, 'workspace.goToTab', {})).toBeNull();
  });
});

describe('coming back from saved shortcuts', () => {
  it('restores only what the user changed', async () => {
    localStorage.setItem(
      'runova-shortcuts',
      JSON.stringify({
        state: { overrides: { 'nav.projects': [{ code: 'KeyJ', mod: true }] } },
        version: 0,
      }),
    );
    await useShortcutStore.persist.rehydrate();
    expect(bindingsFor('nav.projects', overrides())).toEqual([{ code: 'KeyJ', mod: true }]);
    expect(bindingsFor('search.toggle', overrides())).toEqual(defaultsOf('search.toggle'));
  });

  it('saves a change straight away', () => {
    useShortcutStore.getState().setBindings('vault.lock', [{ code: 'KeyQ', mod: true }]);
    const saved = JSON.parse(localStorage.getItem('runova-shortcuts') ?? '{}');
    expect(saved.state.overrides['vault.lock']).toEqual([{ code: 'KeyQ', mod: true }]);
  });
});
