/**
 * App-wide keyboard shortcuts.
 *
 * A binding is stored as the physical key (`KeyboardEvent.code`), never as the
 * character it produces. That is what keeps Ctrl+T working after the user
 * switches to a Farsi, Russian or Greek layout, where the same key reports
 * `event.key === 'ف'`. `event.key` is still accepted as a fallback for letters
 * so remapped layouts like Dvorak match the letter the user actually typed.
 */

export interface Shortcut {
  /** `KeyboardEvent.code`, e.g. `KeyT`, `Backquote`, `Comma`. */
  code: string;
  /** Ctrl on Windows/Linux, Command on macOS. The app treats the two as one key. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type ShortcutCommandId =
  | 'terminal.toggle'
  | 'terminal.new'
  | 'terminal.stopRun'
  | 'terminal.togglePauseRun'
  | 'nav.projects'
  | 'nav.help'
  | 'search.toggle'
  | 'prompt.generate'
  | 'prompt.translate'
  | 'prompt.copy'
  | 'workspace.newTab'
  | 'workspace.buildPrompt'
  | 'workspace.launchAgent'
  | 'workspace.newBrowser'
  | 'workspace.pickElement'
  | 'workspace.closeTab'
  | 'workspace.splitRight'
  | 'workspace.splitDown'
  | 'workspace.focusLeft'
  | 'workspace.focusRight'
  | 'workspace.focusUp'
  | 'workspace.focusDown'
  | 'workspace.nextTab'
  | 'workspace.prevTab'
  | 'workspace.zoomPane'
  | 'workspace.toggleGitPanel'
  | 'workspace.newWorktree'
  | 'workspace.run'
  | 'workspace.search'
  | 'workspace.goToTab'
  | 'workspace.nextChange'
  | 'workspace.prevChange'
  | 'commit.commit'
  | 'commit.commitAndPush'
  | 'vault.search'
  | 'vault.new'
  | 'vault.edit'
  | 'vault.lock'
  | 'vault.copyPassword'
  | 'vault.copyUsername'
  | 'vault.login';

/**
 * Where a shortcut is listened for. `global` runs anywhere in the shell;
 * `prompt` only runs while the prompt builder is on screen, and takes
 * precedence there. Two scopes may share a combination, which is how the
 * prompt builder keeps Ctrl+T for translating while the rest of the app uses
 * it for the terminal. `workspace` works the same way on the Workspace page,
 * and `commit` only inside the changes panel's commit message box. `vault` runs on the Vault
 * page while it is unlocked.
 */
export type ShortcutScope = 'global' | 'prompt' | 'workspace' | 'commit' | 'vault';

export type GlobalShortcutCommandId = Exclude<
  ShortcutCommandId,
  `prompt.${string}` | `workspace.${string}` | `commit.${string}` | `vault.${string}`
>;
export type PromptShortcutCommandId = Extract<ShortcutCommandId, `prompt.${string}`>;
export type WorkspaceShortcutCommandId = Extract<ShortcutCommandId, `workspace.${string}`>;
export type CommitShortcutCommandId = Extract<ShortcutCommandId, `commit.${string}`>;
export type VaultShortcutCommandId = Extract<ShortcutCommandId, `vault.${string}`>;

/** The ids a given scope can produce, so callers get an exhaustive union. */
export type ShortcutCommandIdOf<S extends ShortcutScope> = S extends 'prompt'
  ? PromptShortcutCommandId
  : S extends 'workspace'
    ? WorkspaceShortcutCommandId
    : S extends 'commit'
      ? CommitShortcutCommandId
      : S extends 'vault'
        ? VaultShortcutCommandId
        : GlobalShortcutCommandId;

export interface ShortcutCommand {
  id: ShortcutCommandId;
  label: string;
  description: string;
  group: string;
  scope: ShortcutScope;
  defaults: Shortcut[];
  /**
   * The binding stands for a whole row of number keys: it is stored as `Digit1`, and the same
   * modifiers with 1 to 9 all match, passing the number along (go to tab 3).
   */
  digitRow?: boolean;
}

const DIGIT_CODE = /^Digit([1-9])$/;

/** The number a digit-row binding was pressed with, or null for any other key. */
export function digitOf(code: string): number | null {
  const match = DIGIT_CODE.exec(code);
  return match ? Number(match[1]) : null;
}

export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  {
    id: 'terminal.toggle',
    label: 'Toggle terminal',
    description: 'Opens the terminal drawer, or closes it when it is already open.',
    group: 'Terminal',
    scope: 'global',
    defaults: [
      { code: 'KeyT', mod: true },
      { code: 'Backquote', mod: true },
    ],
  },
  {
    id: 'terminal.new',
    label: 'New terminal tab',
    description: 'Starts another shell in the drawer.',
    group: 'Terminal',
    scope: 'global',
    defaults: [{ code: 'Backquote', mod: true, shift: true }],
  },
  {
    id: 'terminal.stopRun',
    label: 'Stop run',
    description:
      "Closes the project run's terminal and ends everything it started: the run open in the drawer, or else the newest run.",
    group: 'Terminal',
    scope: 'global',
    defaults: [{ code: 'F5', shift: true }],
  },
  {
    id: 'terminal.togglePauseRun',
    label: 'Pause or resume run',
    description:
      'Freezes the project run so it uses no CPU, or lets a paused one carry on: the same run Stop run would pick.',
    group: 'Terminal',
    scope: 'global',
    defaults: [{ code: 'F6' }],
  },
  {
    id: 'nav.projects',
    label: 'Go to Projects',
    description: 'Opens the projects page.',
    group: 'Navigation',
    scope: 'global',
    defaults: [{ code: 'KeyP', mod: true }],
  },
  {
    id: 'nav.help',
    label: 'Open Help',
    description:
      'Opens the Help page, with search and the guide that answers questions about the app.',
    group: 'Navigation',
    scope: 'global',
    defaults: [{ code: 'F1' }],
  },
  {
    id: 'search.toggle',
    label: 'Command palette',
    description: 'Opens search across projects, pages and commands.',
    group: 'Navigation',
    scope: 'global',
    defaults: [{ code: 'KeyK', mod: true }],
  },
  {
    id: 'prompt.generate',
    label: 'Generate prompt',
    description: 'Builds the prompt from your request.',
    group: 'Prompt builder',
    scope: 'prompt',
    defaults: [
      { code: 'KeyG', mod: true },
      { code: 'Enter', mod: true },
    ],
  },
  {
    id: 'prompt.translate',
    label: 'Translate request',
    description: 'Rewrites your request in English without generating.',
    group: 'Prompt builder',
    scope: 'prompt',
    defaults: [{ code: 'KeyT', mod: true }],
  },
  {
    id: 'prompt.copy',
    label: 'Copy generated prompt',
    description: 'Copies the result. Ignored while text is selected, so normal copy still works.',
    group: 'Prompt builder',
    scope: 'prompt',
    defaults: [{ code: 'KeyC', mod: true }],
  },
  {
    id: 'workspace.newTab',
    label: 'New tab',
    description: 'Opens the agent and shell menu in the focused pane.',
    group: 'Workspace',
    scope: 'workspace',
    // Not Ctrl+T: that toggles the general terminal drawer, which stays usable here too.
    defaults: [{ code: 'KeyT', mod: true, shift: true }],
  },
  {
    id: 'workspace.buildPrompt',
    label: 'Build a prompt',
    description:
      'Opens the prompt builder for the project on screen. "Open in agent" then runs it in the focused pane.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'KeyG', mod: true }],
  },
  {
    id: 'workspace.launchAgent',
    label: 'Open agent 1 to 9',
    description:
      'Starts an agent in the focused pane by its place in the "+" menu, so 1 is the first one listed. Settings, Agent order sets the order. Press any number key to set the modifiers.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'Digit1', mod: true }],
    digitRow: true,
  },
  {
    id: 'workspace.newBrowser',
    label: 'New browser tab',
    description: 'Opens a browser tab in the focused pane, for your dev server or any site.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'KeyB', mod: true, shift: true }],
  },
  {
    id: 'workspace.pickElement',
    label: 'Comment on a page element',
    description:
      'In a browser tab, picks an element on the page to leave a comment on for your agent.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'KeyC', mod: true, shift: true }],
  },
  {
    id: 'workspace.closeTab',
    label: 'Close tab',
    description: 'Closes the active tab in the focused pane and ends its shell.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'KeyW', mod: true, shift: true }],
  },
  {
    id: 'workspace.splitRight',
    label: 'Split pane right',
    description: 'Adds a pane to the right of the focused one.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'KeyD', mod: true, shift: true }],
  },
  {
    id: 'workspace.splitDown',
    label: 'Split pane down',
    description: 'Adds a pane below the focused one.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'KeyE', mod: true, shift: true }],
  },
  {
    id: 'workspace.focusLeft',
    label: 'Focus pane on the left',
    description: 'Moves keyboard focus to the pane on the left.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'ArrowLeft', mod: true, alt: true }],
  },
  {
    id: 'workspace.focusRight',
    label: 'Focus pane on the right',
    description: 'Moves keyboard focus to the pane on the right.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'ArrowRight', mod: true, alt: true }],
  },
  {
    id: 'workspace.focusUp',
    label: 'Focus pane above',
    description: 'Moves keyboard focus to the pane above.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'ArrowUp', mod: true, alt: true }],
  },
  {
    id: 'workspace.focusDown',
    label: 'Focus pane below',
    description: 'Moves keyboard focus to the pane below.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'ArrowDown', mod: true, alt: true }],
  },
  {
    id: 'workspace.nextTab',
    label: 'Next tab',
    description: 'Switches to the next tab in the focused pane.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [
      { code: 'Tab', mod: true },
      { code: 'PageDown', mod: true },
    ],
  },
  {
    id: 'workspace.prevTab',
    label: 'Previous tab',
    description: 'Switches to the previous tab in the focused pane.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [
      { code: 'Tab', mod: true, shift: true },
      { code: 'PageUp', mod: true },
    ],
  },
  {
    id: 'workspace.zoomPane',
    label: 'Zoom pane',
    description: 'Lets the focused pane fill the workspace, or puts it back.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'Enter', mod: true, shift: true }],
  },
  {
    id: 'workspace.toggleGitPanel',
    label: 'Toggle changes panel',
    description: 'Shows or hides the git changes panel on the right.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'KeyG', mod: true, shift: true }],
  },
  {
    id: 'workspace.newWorktree',
    label: 'New worktree',
    description:
      'Starts a git worktree of the project on screen: its own folder and branch, with its own terminals and agents.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'KeyN', mod: true, shift: true }],
  },
  {
    id: 'workspace.run',
    label: 'Run project',
    description:
      "Does what the header's Run button does for the project on screen: starts its run command in the terminal, or asks which one when it has several.",
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'F5' }],
  },
  {
    id: 'workspace.search',
    label: 'Search files and code',
    description:
      'Finds files, types, members and text in the project on screen, with a preview. On the workspace it takes Ctrl+P from Go to Projects.',
    group: 'Workspace',
    scope: 'workspace',
    // The quick-open key editors share. The workspace scope is checked first, so Ctrl+P still
    // goes to Projects everywhere else.
    defaults: [{ code: 'KeyP', mod: true }],
  },
  {
    id: 'workspace.goToTab',
    label: 'Go to tab 1 to 9',
    description:
      'Picks a tab in the focused pane by its position. Press any number key to set the modifiers.',
    group: 'Workspace',
    scope: 'workspace',
    // Ctrl+1 to 9 open agents, so tabs moved over to Alt.
    defaults: [{ code: 'Digit1', alt: true }],
    digitRow: true,
  },
  {
    id: 'workspace.nextChange',
    label: 'Next change in diff',
    description: 'Jumps to the next changed block of the diff in the focused pane.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'F7' }],
  },
  {
    id: 'workspace.prevChange',
    label: 'Previous change in diff',
    description: 'Jumps to the previous changed block of the diff in the focused pane.',
    group: 'Workspace',
    scope: 'workspace',
    defaults: [{ code: 'F7', shift: true }],
  },
  {
    id: 'commit.commit',
    label: 'Commit',
    description: 'Commits the staged changes (or stages everything first when nothing is staged).',
    group: 'Changes panel',
    scope: 'commit',
    defaults: [{ code: 'Enter', mod: true }],
  },
  {
    id: 'commit.commitAndPush',
    label: 'Commit and push',
    description: 'Commits, then pushes the branch.',
    group: 'Changes panel',
    scope: 'commit',
    defaults: [{ code: 'Enter', mod: true, shift: true }],
  },
  {
    id: 'vault.search',
    label: 'Search the vault',
    description: 'Puts the cursor in the Vault search box.',
    group: 'Vault',
    scope: 'vault',
    defaults: [{ code: 'KeyF', mod: true }],
  },
  {
    id: 'vault.new',
    label: 'New entry',
    description: 'Opens the editor for a new login, API key, note or custom entry.',
    group: 'Vault',
    scope: 'vault',
    defaults: [{ code: 'KeyN', mod: true }],
  },
  {
    id: 'vault.edit',
    label: 'Edit entry',
    description: 'Opens the selected entry in the editor.',
    group: 'Vault',
    scope: 'vault',
    defaults: [{ code: 'KeyE', mod: true }],
  },
  {
    id: 'vault.lock',
    label: 'Lock the vault',
    description: 'Locks the vault right away.',
    group: 'Vault',
    scope: 'vault',
    defaults: [{ code: 'KeyL', mod: true }],
  },
  {
    id: 'vault.copyPassword',
    label: 'Copy password',
    description: "Copies the selected entry's password, or its secret for an API key.",
    group: 'Vault',
    scope: 'vault',
    defaults: [{ code: 'KeyC', mod: true, shift: true }],
  },
  {
    id: 'vault.copyUsername',
    label: 'Copy username',
    description: "Copies the selected login's username.",
    group: 'Vault',
    scope: 'vault',
    defaults: [{ code: 'KeyB', mod: true, shift: true }],
  },
  {
    id: 'vault.login',
    label: 'Log in',
    description: "Opens the selected login's website and fills in the username and password.",
    group: 'Vault',
    scope: 'vault',
    defaults: [{ code: 'Enter', mod: true }],
  },
];

export const SHORTCUT_GROUPS: { name: string; scope: ShortcutScope; hint?: string }[] = [
  { name: 'Terminal', scope: 'global' },
  { name: 'Navigation', scope: 'global' },
  {
    name: 'Prompt builder',
    scope: 'prompt',
    hint: 'Only while the prompt builder is open, where they beat the app-wide shortcuts.',
  },
  {
    name: 'Workspace',
    scope: 'workspace',
    hint: 'Only on the Workspace page, where they beat the app-wide shortcuts.',
  },
  {
    name: 'Changes panel',
    scope: 'commit',
    hint: 'Only while typing a commit message in the Workspace changes panel.',
  },
  {
    name: 'Vault',
    scope: 'vault',
    hint: 'Only on the Vault page while it is unlocked.',
  },
];

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
]);

export type KeyEventLike = Pick<
  KeyboardEvent,
  'code' | 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
>;

function letterOf(code: string): string | null {
  return /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : null;
}

/** Reads a binding off a keypress. Null while only modifiers are held down. */
export function shortcutFromEvent(event: KeyEventLike): Shortcut | null {
  if (!event.code || MODIFIER_CODES.has(event.code)) return null;
  const shortcut: Shortcut = { code: event.code };
  if (event.ctrlKey || event.metaKey) shortcut.mod = true;
  if (event.shiftKey) shortcut.shift = true;
  if (event.altKey) shortcut.alt = true;
  return shortcut;
}

export function matchesShortcut(
  event: KeyEventLike,
  shortcut: Shortcut,
  digitRow = false,
): boolean {
  if ((event.ctrlKey || event.metaKey) !== Boolean(shortcut.mod)) return false;
  if (event.shiftKey !== Boolean(shortcut.shift)) return false;
  if (event.altKey !== Boolean(shortcut.alt)) return false;
  if (digitRow) return digitOf(event.code) !== null;
  if (event.code === shortcut.code) return true;
  const letter = letterOf(shortcut.code);
  return letter !== null && event.key.toLowerCase() === letter;
}

/** Stable string form, used for comparing and for React keys. */
export function shortcutId(shortcut: Shortcut): string {
  return [
    shortcut.mod ? 'mod' : '',
    shortcut.alt ? 'alt' : '',
    shortcut.shift ? 'shift' : '',
    shortcut.code,
  ]
    .filter(Boolean)
    .join('+');
}

export function sameShortcut(a: Shortcut, b: Shortcut): boolean {
  return shortcutId(a) === shortcutId(b);
}

export function hasModifier(shortcut: Shortcut): boolean {
  return Boolean(shortcut.mod || shortcut.alt);
}

/** True when the binding cannot be mistaken for the user typing into a field. */
export function isSafeWhileTyping(shortcut: Shortcut): boolean {
  return hasModifier(shortcut) || /^F\d{1,2}$/.test(shortcut.code);
}

/**
 * Why a binding cannot be accepted, or null when it is fine. Anything without
 * Ctrl/Cmd/Alt would swallow ordinary typing, so only the function keys are
 * allowed to stand on their own.
 */
export function bindingProblem(shortcut: Shortcut): string | null {
  return isSafeWhileTyping(shortcut) ? null : 'Hold Ctrl, Cmd, or Alt, or use a function key.';
}

const KEY_LABELS: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  IntlBackslash: '\\',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Del',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
};

/** Human name for a physical key, independent of the active keyboard layout. */
export function keyLabel(code: string): string {
  const letter = letterOf(code);
  if (letter) return letter.toUpperCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return KEY_LABELS[code] ?? code;
}

export function isMacPlatform(): boolean {
  return typeof window !== 'undefined' && window.runova?.platform === 'darwin';
}

/** A binding as shown for its command: a digit-row one reads "Ctrl+1…9". */
export function formatCommandShortcut(command: ShortcutCommand, shortcut: Shortcut): string {
  const text = formatShortcut(shortcut);
  return command.digitRow ? `${text.slice(0, -1)}1…9` : text;
}

export function formatShortcut(shortcut: Shortcut): string {
  const mac = isMacPlatform();
  const parts: string[] = [];
  if (shortcut.mod) parts.push(mac ? '⌘' : 'Ctrl');
  if (shortcut.alt) parts.push(mac ? '⌥' : 'Alt');
  if (shortcut.shift) parts.push(mac ? '⇧' : 'Shift');
  parts.push(keyLabel(shortcut.code));
  return parts.join(mac ? '' : '+');
}
