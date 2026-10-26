import type { AlertKind } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { TELEGRAM_ALERT_KINDS } from '@shared/deploy/telegramValidation';
import type { DeployTelegramStatus } from '@shared/deployTelegramTypes';
import type { ChipTone } from '@/components/pageKit';

/** The words of the Telegram card, and what its state is called. */

export type TelegramStateKey = 'off' | 'paused' | 'waiting' | 'sending' | 'failing';

export interface TelegramState {
  key: TelegramStateKey;
  label: string;
  tone: ChipTone;
}

/** How sending stands, as one word for a chip. A failure the core still holds beats a delivery. */
export function telegramState(status: DeployTelegramStatus): TelegramState {
  if (!status.configured) return { key: 'off', label: 'Not set up', tone: 'neutral' };
  if (!status.enabled) return { key: 'paused', label: 'Paused', tone: 'neutral' };
  if (status.lastError && (status.lastFailedAtUnixMs ?? 0) >= (status.lastSentAtUnixMs ?? 0)) {
    return { key: 'failing', label: 'Last send failed', tone: 'destructive' };
  }
  if (status.lastSentAtUnixMs !== undefined || status.sentCount > 0) {
    return { key: 'sending', label: 'Sending', tone: 'success' };
  }
  return { key: 'waiting', label: 'On, nothing sent yet', tone: 'primary' };
}

/** "Every alert", or the chosen ones by name, in the form's order. */
export function kindsText(kinds: readonly AlertKind[]): string {
  if (kinds.length === 0) return 'None (nothing is sent)';
  if (kinds.length === TELEGRAM_ALERT_KINDS.length) return 'Every alert';
  return TELEGRAM_ALERT_KINDS.filter((kind) => kinds.includes(kind.value))
    .map((kind) => kind.label)
    .join(', ');
}

/** What to do in Telegram to get a bot and a chat ID, for a server that has none yet. */
export const SETUP_STEPS: readonly string[] = [
  'In Telegram, open @BotFather, send /newbot and follow its questions. It answers with the bot token.',
  'Send your new bot any message, or add it to the group that should get the alerts.',
  'Paste the token below, press Detect to fill in the chat ID, and turn it on.',
];

/** Said wherever the card promises what leaves the server, so the promise reads the same everywhere. */
export const PRIVACY_NOTE =
  'The server sends the alerts itself, so they arrive while this app is closed. Passwords, tokens and keys are removed from every alert before it is stored or sent.';
