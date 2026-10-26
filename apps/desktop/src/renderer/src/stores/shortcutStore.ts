import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  digitOf,
  formatCommandShortcut,
  formatShortcut,
  isSafeWhileTyping,
  matchesShortcut,
  SHORTCUT_COMMANDS,
  type Shortcut,
  type ShortcutCommand,
  type ShortcutCommandId,
  type ShortcutCommandIdOf,
  type ShortcutScope,
  sameShortcut,
} from '@/lib/shortcuts';

export type ShortcutOverrides = Partial<Record<ShortcutCommandId, Shortcut[]>>;

interface ShortcutState {
  /**
   * Only the commands the user actually changed. Anything absent falls back to
   * the registry default, so later default changes still reach existing users
   * instead of being frozen into their saved copy.
   */
  overrides: ShortcutOverrides;
  setBindings: (id: ShortcutCommandId, bindings: Shortcut[]) => void;
  resetCommand: (id: ShortcutCommandId) => void;
  resetAll: () => void;
}

export const useShortcutStore = create<ShortcutState>()(
  persist(
    (set) => ({
      overrides: {},
      setBindings: (id, bindings) =>
        set((state) => ({ overrides: { ...state.overrides, [id]: bindings } })),
      resetCommand: (id) =>
        set((state) => {
          const { [id]: _removed, ...rest } = state.overrides;
          return { overrides: rest };
        }),
      resetAll: () => set({ overrides: {} }),
    }),
    { name: 'runova-shortcuts' },
  ),
);

function commandById(id: ShortcutCommandId): ShortcutCommand | undefined {
  return SHORTCUT_COMMANDS.find((command) => command.id === id);
}

export function bindingsFor(id: ShortcutCommandId, overrides: ShortcutOverrides): Shortcut[] {
  return overrides[id] ?? commandById(id)?.defaults ?? [];
}

/** Both branches return a stable reference, so this is safe as a zustand selector. */
export function useShortcutBindings(id: ShortcutCommandId): Shortcut[] {
  return useShortcutStore((state) => bindingsFor(id, state.overrides));
}

/** The first binding rendered for labels and tooltips, or null when unbound. */
export function useShortcutLabel(id: ShortcutCommandId): string | null {
  const bindings = useShortcutBindings(id);
  const first = bindings[0];
  const command = commandById(id);
  if (!first) return null;
  return command ? formatCommandShortcut(command, first) : formatShortcut(first);
}

/** Every binding as one phrase, e.g. "Ctrl+G or Ctrl+Enter". Null when unbound. */
export function useShortcutLabelList(id: ShortcutCommandId): string | null {
  const bindings = useShortcutBindings(id);
  if (bindings.length === 0) return null;
  return bindings.map(formatShortcut).join(' or ');
}

/**
 * The command a keypress triggers, or null. `requireModifier` drops bare-key
 * bindings while the user is typing into a field, where they would swallow
 * ordinary input.
 */
export function commandForEvent<S extends ShortcutScope = 'global'>(
  event: Parameters<typeof matchesShortcut>[0],
  overrides: ShortcutOverrides,
  requireModifier = false,
  scope: S = 'global' as S,
): ShortcutCommandIdOf<S> | null {
  for (const command of SHORTCUT_COMMANDS) {
    if (command.scope !== scope) continue;
    for (const binding of bindingsFor(command.id, overrides)) {
      if (requireModifier && !isSafeWhileTyping(binding)) continue;
      if (matchesShortcut(event, binding, command.digitRow)) {
        return command.id as ShortcutCommandIdOf<S>;
      }
    }
  }
  return null;
}

/**
 * The command already using this binding, so the settings UI can refuse a
 * duplicate. Only commands in the same scope can clash: the prompt builder is
 * free to reuse a combination the shell also listens for.
 */
export function conflictingCommand(
  shortcut: Shortcut,
  exceptId: ShortcutCommandId,
  overrides: ShortcutOverrides,
): ShortcutCommand | null {
  const scope = SHORTCUT_COMMANDS.find((command) => command.id === exceptId)?.scope;
  for (const command of SHORTCUT_COMMANDS) {
    if (command.id === exceptId || command.scope !== scope) continue;
    const taken = bindingsFor(command.id, overrides).some((binding) =>
      // A number-row binding owns every digit with its modifiers, not just the one stored.
      command.digitRow || commandById(exceptId)?.digitRow
        ? digitOf(binding.code) !== null &&
          digitOf(shortcut.code) !== null &&
          sameShortcut({ ...binding, code: 'Digit1' }, { ...shortcut, code: 'Digit1' })
        : sameShortcut(binding, shortcut),
    );
    if (taken) return command;
  }
  return null;
}
