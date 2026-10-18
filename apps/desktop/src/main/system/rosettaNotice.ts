import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, type BrowserWindow, dialog, shell } from 'electron';
import { isRunningUnderRosetta, RELEASES_URL } from './rosetta';

const NOTICE_DISMISSED_FILE = 'rosetta-notice-dismissed';

/**
 * Tells the user once per launch that they're on the wrong build, until they tick "Don't show
 * this again".
 */
export async function showRosettaNotice(win: BrowserWindow | null): Promise<void> {
  if (!isRunningUnderRosetta()) return;
  const marker = join(app.getPath('userData'), NOTICE_DISMISSED_FILE);
  if (existsSync(marker)) return;
  const options = {
    type: 'warning' as const,
    title: 'Install the Apple Silicon version',
    message: 'This is the Intel version of AgentMate',
    detail:
      'Your Mac has an Apple Silicon chip, so macOS runs this version through Rosetta. ' +
      'Git, the built-in terminals and other developer tools fail under it with ' +
      '"missing compatible architecture". Download the arm64 version from the releases page ' +
      'and drag it over this one in Applications. Your projects and settings are kept.\n\n' +
      'The next update also switches you to the Apple Silicon version on its own.',
    buttons: ['Open releases page', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    checkboxLabel: "Don't show this again",
  };
  const { response, checkboxChecked } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  if (response === 0) void shell.openExternal(RELEASES_URL);
  if (checkboxChecked) await writeFile(marker, '').catch(() => undefined);
}
