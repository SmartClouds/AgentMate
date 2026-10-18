import { describe, expect, it } from 'vitest';
import { installAgentmatBridge } from '../../../test/renderer/agentmatBridge';
import {
  bindingProblem,
  digitOf,
  formatCommandShortcut,
  formatShortcut,
  hasModifier,
  isMacPlatform,
  isSafeWhileTyping,
  type KeyEventLike,
  keyLabel,
  matchesShortcut,
  SHORTCUT_COMMANDS,
  SHORTCUT_GROUPS,
  type Shortcut,
  sameShortcut,
  shortcutFromEvent,
  shortcutId,
} from './shortcuts';

/** A keypress as the app sees it. Defaults are "no modifiers held". */
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

describe('digitOf', () => {
  it('reads the number off a number-row key', () => {
    expect(digitOf('Digit1')).toBe(1);
    expect(digitOf('Digit9')).toBe(9);
  });

  it('has no number for anything else, including zero', () => {
    // The go-to-tab row is 1 to 9; there is no tab 0.
    expect(digitOf('Digit0')).toBeNull();
    expect(digitOf('Numpad1')).toBeNull();
    expect(digitOf('KeyT')).toBeNull();
    expect(digitOf('')).toBeNull();
  });
});

describe('shortcutFromEvent', () => {
  it('reads the physical key and the modifiers held with it', () => {
    expect(
      shortcutFromEvent(press({ code: 'KeyT', key: 't', ctrlKey: true, shiftKey: true })),
    ).toEqual({ code: 'KeyT', mod: true, shift: true });
  });

  it('treats Command the same as Ctrl', () => {
    expect(shortcutFromEvent(press({ code: 'KeyK', key: 'k', metaKey: true }))).toEqual({
      code: 'KeyK',
      mod: true,
    });
  });

  it('stores the physical key, not the letter a layout produces', () => {
    // On a Farsi layout this key types "ف"; the binding still has to be KeyT.
    expect(shortcutFromEvent(press({ code: 'KeyT', key: 'ف', ctrlKey: true }))?.code).toBe('KeyT');
  });

  it('is nothing while only modifiers are down', () => {
    expect(
      shortcutFromEvent(press({ code: 'ControlLeft', key: 'Control', ctrlKey: true })),
    ).toBeNull();
    expect(
      shortcutFromEvent(press({ code: 'ShiftRight', key: 'Shift', shiftKey: true })),
    ).toBeNull();
    expect(shortcutFromEvent(press({ code: 'MetaLeft', key: 'Meta', metaKey: true }))).toBeNull();
    expect(shortcutFromEvent(press({ code: 'CapsLock', key: 'CapsLock' }))).toBeNull();
  });

  it('is nothing for a synthesized press with no physical key', () => {
    expect(shortcutFromEvent(press({ code: '', key: 'v', ctrlKey: true }))).toBeNull();
  });

  it('leaves unheld modifiers off the binding entirely', () => {
    expect(shortcutFromEvent(press({ code: 'F7', key: 'F7' }))).toEqual({ code: 'F7' });
  });
});

describe('matchesShortcut', () => {
  const ctrlT: Shortcut = { code: 'KeyT', mod: true };

  it('matches the physical key on a Latin layout', () => {
    expect(matchesShortcut(press({ code: 'KeyT', key: 't', ctrlKey: true }), ctrlT)).toBe(true);
  });

  it('matches the physical key on a Farsi layout', () => {
    // This is what keeps Ctrl+T working after the user switches input language.
    expect(matchesShortcut(press({ code: 'KeyT', key: 'ف', ctrlKey: true }), ctrlT)).toBe(true);
  });

  it('matches the typed letter on a layout that moves keys around', () => {
    // Dvorak puts T where QWERTY has K, so the code differs but the letter is right.
    expect(matchesShortcut(press({ code: 'KeyK', key: 't', ctrlKey: true }), ctrlT)).toBe(true);
  });

  it('matches the typed letter regardless of its case', () => {
    expect(matchesShortcut(press({ code: 'KeyK', key: 'T', ctrlKey: true }), ctrlT)).toBe(true);
  });

  it('takes Command as the mod key, so a binding works on both platforms', () => {
    expect(matchesShortcut(press({ code: 'KeyT', key: 't', metaKey: true }), ctrlT)).toBe(true);
  });

  it('refuses a press with the wrong modifiers', () => {
    expect(matchesShortcut(press({ code: 'KeyT', key: 't' }), ctrlT)).toBe(false);
    expect(
      matchesShortcut(press({ code: 'KeyT', key: 't', ctrlKey: true, shiftKey: true }), ctrlT),
    ).toBe(false);
    expect(
      matchesShortcut(press({ code: 'KeyT', key: 't', ctrlKey: true, altKey: true }), ctrlT),
    ).toBe(false);
  });

  it('refuses a modifier the binding does not ask for, even on a bare key', () => {
    expect(matchesShortcut(press({ code: 'F7', key: 'F7', shiftKey: true }), { code: 'F7' })).toBe(
      false,
    );
    expect(
      matchesShortcut(press({ code: 'F7', key: 'F7', shiftKey: true }), {
        code: 'F7',
        shift: true,
      }),
    ).toBe(true);
  });

  it('does not fall back to the letter for a non-letter binding', () => {
    // Backquote has no letter, so only the physical key can match it.
    expect(
      matchesShortcut(press({ code: 'KeyB', key: '`', ctrlKey: true }), {
        code: 'Backquote',
        mod: true,
      }),
    ).toBe(false);
  });

  it('lets a digit-row binding stand for every number with those modifiers', () => {
    const goToTab: Shortcut = { code: 'Digit1', mod: true };
    expect(matchesShortcut(press({ code: 'Digit1', key: '1', ctrlKey: true }), goToTab, true)).toBe(
      true,
    );
    expect(matchesShortcut(press({ code: 'Digit7', key: '7', ctrlKey: true }), goToTab, true)).toBe(
      true,
    );
    // Not zero, and not the numpad: there is no tab 0 and the numpad is a different key.
    expect(matchesShortcut(press({ code: 'Digit0', key: '0', ctrlKey: true }), goToTab, true)).toBe(
      false,
    );
    expect(
      matchesShortcut(press({ code: 'Numpad3', key: '3', ctrlKey: true }), goToTab, true),
    ).toBe(false);
  });
});

describe('shortcutId and sameShortcut', () => {
  it('writes the modifiers in a fixed order, so the same binding always reads the same', () => {
    expect(shortcutId({ code: 'KeyT', mod: true, shift: true, alt: true })).toBe(
      'mod+alt+shift+KeyT',
    );
    expect(shortcutId({ code: 'F7' })).toBe('F7');
  });

  it('treats a missing modifier and an explicit false as the same binding', () => {
    expect(
      sameShortcut({ code: 'KeyT', mod: true }, { code: 'KeyT', mod: true, shift: false }),
    ).toBe(true);
  });

  it('tells apart bindings that differ only in a modifier', () => {
    expect(
      sameShortcut({ code: 'KeyT', mod: true }, { code: 'KeyT', mod: true, shift: true }),
    ).toBe(false);
  });
});

describe('hasModifier, isSafeWhileTyping and bindingProblem', () => {
  it('counts Ctrl/Cmd and Alt as modifiers, but not Shift on its own', () => {
    expect(hasModifier({ code: 'KeyT', mod: true })).toBe(true);
    expect(hasModifier({ code: 'ArrowLeft', alt: true })).toBe(true);
    expect(hasModifier({ code: 'KeyT', shift: true })).toBe(false);
  });

  it('lets a function key stand alone, since it cannot be typed into a field', () => {
    expect(isSafeWhileTyping({ code: 'F7' })).toBe(true);
    expect(isSafeWhileTyping({ code: 'F12', shift: true })).toBe(true);
    expect(isSafeWhileTyping({ code: 'KeyT' })).toBe(false);
    expect(isSafeWhileTyping({ code: 'KeyT', shift: true })).toBe(false);
  });

  it('explains why a bare key cannot be bound', () => {
    expect(bindingProblem({ code: 'KeyT', mod: true })).toBeNull();
    expect(bindingProblem({ code: 'F7' })).toBeNull();
    expect(bindingProblem({ code: 'KeyT', shift: true })).toBe(
      'Hold Ctrl, Cmd, or Alt, or use a function key.',
    );
  });
});

describe('keyLabel', () => {
  it('names a letter, a digit and a function key by what is printed on it', () => {
    expect(keyLabel('KeyT')).toBe('T');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('Numpad3')).toBe('Num 3');
    expect(keyLabel('F7')).toBe('F7');
    expect(keyLabel('F12')).toBe('F12');
  });

  it('spells out the punctuation and navigation keys', () => {
    expect(keyLabel('Backquote')).toBe('`');
    expect(keyLabel('Comma')).toBe(',');
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('PageDown')).toBe('PgDn');
    expect(keyLabel('Escape')).toBe('Esc');
  });

  it('falls back to the code itself for a key it has no name for', () => {
    expect(keyLabel('BrowserHome')).toBe('BrowserHome');
  });
});

describe('formatShortcut', () => {
  it('spells the modifiers out with plus signs off macOS', () => {
    installAgentmatBridge({ platform: 'win32' });
    expect(formatShortcut({ code: 'KeyT', mod: true })).toBe('Ctrl+T');
    expect(formatShortcut({ code: 'ArrowLeft', mod: true, alt: true })).toBe('Ctrl+Alt+←');
    expect(formatShortcut({ code: 'Enter', mod: true, shift: true })).toBe('Ctrl+Shift+Enter');
    expect(isMacPlatform()).toBe(false);
  });

  it('uses the Mac symbols, run together, on macOS', () => {
    installAgentmatBridge({ platform: 'darwin' });
    expect(isMacPlatform()).toBe(true);
    expect(formatShortcut({ code: 'KeyT', mod: true })).toBe('⌘T');
    expect(formatShortcut({ code: 'KeyT', mod: true, alt: true, shift: true })).toBe('⌘⌥⇧T');
  });

  it('shows a digit-row binding as a range', () => {
    installAgentmatBridge({ platform: 'win32' });
    const goToTab = SHORTCUT_COMMANDS.find((command) => command.id === 'workspace.goToTab');
    if (!goToTab) throw new Error('workspace.goToTab is missing from the registry');
    expect(formatCommandShortcut(goToTab, goToTab.defaults[0])).toBe('Alt+1…9');
    const launchAgent = SHORTCUT_COMMANDS.find((command) => command.id === 'workspace.launchAgent');
    if (!launchAgent) throw new Error('workspace.launchAgent is missing from the registry');
    expect(formatCommandShortcut(launchAgent, launchAgent.defaults[0])).toBe('Ctrl+1…9');
  });

  it('leaves a normal command is binding as it is', () => {
    installAgentmatBridge({ platform: 'win32' });
    const newTab = SHORTCUT_COMMANDS.find((command) => command.id === 'workspace.newTab');
    if (!newTab) throw new Error('workspace.newTab is missing from the registry');
    expect(formatCommandShortcut(newTab, newTab.defaults[0])).toBe('Ctrl+Shift+T');
  });
});

describe('the command registry', () => {
  it('opens the workspace search with Ctrl+P, only on the workspace', () => {
    const search = SHORTCUT_COMMANDS.find((command) => command.id === 'workspace.search');
    expect(search).toMatchObject({
      scope: 'workspace',
      group: 'Workspace',
      defaults: [{ code: 'KeyP', mod: true }],
    });
  });

  it('stops a project run with Shift+F5 from anywhere, beside F5 for Run', () => {
    const stop = SHORTCUT_COMMANDS.find((command) => command.id === 'terminal.stopRun');
    expect(stop).toMatchObject({
      scope: 'global',
      group: 'Terminal',
      defaults: [{ code: 'F5', shift: true }],
    });
    // The workspace scope is tried first on the Workspace, so nothing there may take Shift+F5.
    const taken = SHORTCUT_COMMANDS.filter(
      (command) =>
        command.id !== 'terminal.stopRun' &&
        command.defaults.some((binding) => sameShortcut(binding, { code: 'F5', shift: true })),
    );
    expect(taken).toEqual([]);
  });

  it('pauses or resumes a project run with F6 from anywhere, as in a debugger', () => {
    const pause = SHORTCUT_COMMANDS.find((command) => command.id === 'terminal.togglePauseRun');
    expect(pause).toMatchObject({
      scope: 'global',
      group: 'Terminal',
      defaults: [{ code: 'F6' }],
    });
    // A bare function key still reaches the app from inside a focused terminal.
    expect(isSafeWhileTyping({ code: 'F6' })).toBe(true);
    const taken = SHORTCUT_COMMANDS.filter(
      (command) =>
        command.id !== 'terminal.togglePauseRun' &&
        command.defaults.some((binding) => sameShortcut(binding, { code: 'F6' })),
    );
    expect(taken).toEqual([]);
  });

  it('gives every command an id of its own', () => {
    const ids = SHORTCUT_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every command a group that the settings page lists', () => {
    const groups = new Set(SHORTCUT_GROUPS.map((group) => group.name));
    for (const command of SHORTCUT_COMMANDS) expect(groups.has(command.group)).toBe(true);
  });

  it('puts every command in the scope its group is listed under', () => {
    for (const command of SHORTCUT_COMMANDS) {
      const group = SHORTCUT_GROUPS.find((one) => one.name === command.group);
      expect(group?.scope).toBe(command.scope);
    }
  });

  it('only ships defaults that could be accepted in the settings page', () => {
    for (const command of SHORTCUT_COMMANDS) {
      for (const binding of command.defaults) expect(bindingProblem(binding)).toBeNull();
    }
  });

  it('never gives two commands in one scope the same default binding', () => {
    const seen = new Map<string, string>();
    for (const command of SHORTCUT_COMMANDS) {
      for (const binding of command.defaults) {
        // A digit-row binding owns the whole row, so it is compared as its first key.
        const code = command.digitRow ? 'DigitRow' : binding.code;
        const key = `${command.scope}|${shortcutId({ ...binding, code })}`;
        expect(seen.get(key), `${key} is bound twice`).toBeUndefined();
        seen.set(key, command.id);
      }
    }
  });
});
