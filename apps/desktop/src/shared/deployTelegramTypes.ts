import type {
  AlertKind,
  TelegramNotificationsStatus,
  TelegramNotificationsTestResult,
} from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Telegram notifications (E30): a server core sends its alerts (a failed backup, a container that
 * keeps restarting, a full disk...) to a Telegram chat through a bot, whether or not the app is open.
 * The bot token only ever goes in, from the form to the core, which seals it and never returns it;
 * the status says which chat, never the token.
 */

/** How Telegram notifications stand on a server, as the core describes them. */
export type DeployTelegramStatus = TelegramNotificationsStatus;

/** What a test message came to: whether Telegram took it, and why not. */
export type DeployTelegramTestResult = TelegramNotificationsTestResult;

/** The password or authenticator code a step-up needs, when the core asked for one. */
export interface DeployTelegramProof {
  password?: string;
  totpCode?: string;
}

/**
 * Sets notifications up or changes them (an Owner, with a step-up). Leave `botToken` out to keep the
 * one the core already has, so the chat or the kinds can change without pasting the token again.
 */
export interface DeployTelegramSaveInput extends DeployTelegramProof {
  serverId: string;
  botToken?: string;
  enabled: boolean;
  chatId: string;
  /** Empty means the machine's own name. */
  serverName: string;
  kinds: AlertKind[];
  sendResolved: boolean;
}

export interface DeployTelegramRemoveInput extends DeployTelegramProof {
  serverId: string;
}

/** Saved when `problems` is empty (and `status` says how it stands); otherwise nothing was saved. */
export interface DeployTelegramSaveResult {
  problems: string[];
  status: DeployTelegramStatus | null;
}

/** The chat that last wrote to the bot, so nobody has to hunt for its ID; or why there is none. */
export interface DeployTelegramDetectResult {
  chatId: string | null;
  error?: string;
}
