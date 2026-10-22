import type { TelegramNotificationsRequest } from '../../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/AgentMate.ServerCore.Contracts';
import {
  checkBotToken,
  checkChatId,
  checkKinds,
  checkTelegramServerName,
} from '../../../shared/deploy/telegramValidation';
import type {
  DeployTelegramDetectResult,
  DeployTelegramProof,
  DeployTelegramRemoveInput,
  DeployTelegramSaveInput,
  DeployTelegramSaveResult,
  DeployTelegramStatus,
  DeployTelegramTestResult,
} from '../../../shared/deployTelegramTypes';
import { type CoreCallDeps, callCore } from '../coreCalls';

/**
 * Telegram notifications on a server (E30): the core sends its alerts to a Telegram chat through a
 * bot, and these calls read how that stands, set it up, remove it and send a test message. Setting
 * up and removing send what happens on the server to a third party, so they are an Owner's call
 * with a step-up; the call makes the step-up on the way when it is handed the password or a code.
 * The token only goes in. The core seals it and never returns it, so nothing here can hand one back.
 */

/** Who may step up for the calls that change the setup. */
const OWNER_ROLES: ReadonlySet<string> = new Set(['owner']);

/** What a core without this feature answers to an unknown hub method. */
const MISSING_METHOD = /Method does not exist/i;

export interface DeployTelegramDeps extends CoreCallDeps {
  /** Asks Telegram, from this computer, which chat last wrote to the bot. */
  detectChat: (botToken: string) => Promise<{ chatId: string | null; error?: string }>;
}

async function stepUp(hub: ICoreHub, proof: DeployTelegramProof): Promise<void> {
  if (proof.password || proof.totpCode) {
    await hub.stepUp({
      ...(proof.password ? { password: proof.password } : {}),
      ...(proof.totpCode ? { totpCode: proof.totpCode } : {}),
    });
  }
}

/** The token is part of every Bot API address, so an error about one may carry it. */
function scrub(text: string, token: string): string {
  const secret = token.slice(token.indexOf(':') + 1);
  return text.split(token).join('[token]').split(secret).join('[token]');
}

export class DeployTelegram {
  constructor(private readonly deps: DeployTelegramDeps) {}

  status(serverId: string): Promise<DeployTelegramStatus> {
    return this.call(serverId, (hub) => hub.getTelegramNotifications());
  }

  async save(input: DeployTelegramSaveInput): Promise<DeployTelegramSaveResult> {
    const request = this.request(input);
    const result = await this.call(
      input.serverId,
      async (hub) => {
        await stepUp(hub, input);
        return hub.saveTelegramNotifications(request);
      },
      OWNER_ROLES,
    );
    return { problems: result.problems, status: result.status ?? null };
  }

  remove(input: DeployTelegramRemoveInput): Promise<DeployTelegramStatus> {
    return this.call(
      input.serverId,
      async (hub) => {
        await stepUp(hub, input);
        return hub.removeTelegramNotifications();
      },
      OWNER_ROLES,
    );
  }

  test(serverId: string): Promise<DeployTelegramTestResult> {
    return this.call(serverId, (hub) => hub.sendTelegramNotificationTest());
  }

  /**
   * Finds the chat ID for the form: the person or group that last wrote to the bot. This one call
   * goes from this computer to Telegram, before the token is saved on the server.
   */
  async detectChat(botToken: string): Promise<DeployTelegramDetectResult> {
    const token = checkBotToken(botToken);
    if (!token.ok) throw new Error(token.reason);
    const found = await this.deps.detectChat(token.value);
    return found.error
      ? { chatId: found.chatId, error: scrub(found.error, token.value) }
      : { chatId: found.chatId };
  }

  /** The request the core takes, after the same checks the form made. The core checks again. */
  private request(input: DeployTelegramSaveInput): TelegramNotificationsRequest {
    let botToken: string | undefined;
    if (input.botToken?.trim()) {
      const token = checkBotToken(input.botToken);
      if (!token.ok) throw new Error(token.reason);
      botToken = token.value;
    }
    const chat = checkChatId(input.chatId);
    if (!chat.ok) throw new Error(chat.reason);
    const serverName = checkTelegramServerName(input.serverName);
    if (!serverName.ok) throw new Error(serverName.reason);
    const kinds = checkKinds(input.kinds);
    if (!kinds.ok) throw new Error(kinds.reason);
    return {
      enabled: input.enabled,
      ...(botToken ? { botToken } : {}),
      chatId: chat.value,
      serverName: serverName.value,
      kinds: kinds.value,
      sendResolved: input.sendResolved,
    };
  }

  private async call<T>(
    serverId: string,
    work: (hub: ICoreHub) => Promise<T>,
    stepUpFor?: ReadonlySet<string>,
  ): Promise<T> {
    try {
      return await callCore(this.deps, serverId, work, stepUpFor ? { stepUpFor } : {});
    } catch (error) {
      if (error instanceof Error && MISSING_METHOD.test(error.message)) {
        throw new Error(
          'This server runs an older core without Telegram notifications. Update the core from the Overview, then try again.',
        );
      }
      throw error;
    }
  }
}
