import { app, ipcMain, session } from 'electron';
import { IPC } from '../shared/ipcChannels';
import { isEditCommand, type SpellcheckMenuPayload } from '../shared/spellcheck';

// Chromium loads one hunspell dictionary per language and only flags a word
// when none of them knows it, but it gets slower and noisier with every extra
// dictionary, so keep the list short.
const MAX_LANGUAGES = 3;

/**
 * The system languages first, so someone writing Persian or German gets their
 * own dictionary, then en-US, because most of what people type into Runova
 * (prompts, project notes) is English either way.
 */
function preferredLanguages(available: string[]): string[] {
  const picked: string[] = [];
  const add = (tag: string): void => {
    // Chromium wants the exact tag it ships a dictionary for, so "en" or
    // "fa-IR" has to fall back to the first available tag with the same base.
    const base = tag.split('-')[0].toLowerCase();
    const match =
      available.find((candidate) => candidate.toLowerCase() === tag.toLowerCase()) ??
      available.find((candidate) => candidate.split('-')[0].toLowerCase() === base);
    if (match && !picked.includes(match)) picked.push(match);
  };
  for (const tag of app.getPreferredSystemLanguages()) add(tag);
  add('en-US');
  return picked.slice(0, MAX_LANGUAGES);
}

/**
 * Turns on the red squiggly underline under misspelled words in every text box
 * that has not opted out with `spellCheck={false}`. Call it once the app is
 * ready and before any window exists.
 */
export function configureSpellChecker(): void {
  const ses = session.defaultSession;
  ses.setSpellCheckerEnabled(true);
  // macOS uses the OS spellchecker, which picks languages on its own and has no
  // dictionary list to hand out.
  if (process.platform === 'darwin') return;
  try {
    ses.setSpellCheckerLanguages(preferredLanguages(ses.availableSpellCheckerLanguages));
  } catch {
    // An unsupported tag slipped through; Chromium's own default is fine.
  }
}

/**
 * Forwards every right-click inside an editable field to the renderer, along
 * with whatever Chromium's spellchecker had to say about the word under the
 * cursor and which editing commands the field can take. The renderer draws the
 * field menu itself instead of the OS one: spelling and grammar fixes when
 * there are any, and always Cut, Copy, Paste and Select all.
 */
export function registerSpellcheckHandlers(): void {
  ipcMain.handle(IPC.spellcheck.addToDictionary, (_event, word: string): boolean => {
    if (typeof word !== 'string' || !word.trim()) return false;
    return session.defaultSession.addWordToSpellCheckerDictionary(word);
  });

  // The renderer draws the menu, so these have to come back here to happen. The
  // contents' own commands are used because they behave exactly like the OS menu
  // would: they work on any input type, keep the undo stack and send the input
  // event a controlled React field listens for. The allowlist matters because the
  // command name is called as a method on the sender.
  ipcMain.handle(IPC.spellcheck.runEditCommand, (event, command: unknown): boolean => {
    if (!isEditCommand(command)) return false;
    event.sender[command]();
    return true;
  });

  // Every window gets the same treatment (main, floating widgets, the pet, the
  // remote session), so hook contents as they are created rather than one
  // known window.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('context-menu', (_contextMenuEvent, params) => {
      if (!params.isEditable) return;
      const payload: SpellcheckMenuPayload = {
        word: params.misspelledWord,
        suggestions: params.dictionarySuggestions,
        selectionText: params.selectionText,
        editFlags: {
          canCut: params.editFlags.canCut,
          canCopy: params.editFlags.canCopy,
          canPaste: params.editFlags.canPaste,
          canSelectAll: params.editFlags.canSelectAll,
        },
      };
      contents.send(IPC.spellcheck.onShowMenu, payload);
    });
  });
}
