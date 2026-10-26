import { coreErrorMessage } from '@shared/coreErrors';
import type {
  DeployTelegramDetectResult,
  DeployTelegramStatus,
  DeployTelegramTestResult,
} from '@shared/deployTelegramTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Pencil } from '@/components/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';
import { useProofStepUp } from '../overview/useProofStepUp';
import { CARD_BODY, SecurityCard } from '../security/SecurityCard';
import { TelegramForm, type TelegramValues } from './TelegramForm';
import { TelegramStatusCard } from './TelegramStatusCard';

/**
 * Telegram alerts (E30) for one server: its core sends important events and errors (a failed
 * backup, a container that keeps restarting, a full disk...) to a person or group on Telegram, even
 * while this app is closed. Admins and Owners see how it stands and send a test message; Owners set
 * it up, change it and remove it, each after a step-up when the last one ran out. The token only
 * ever goes in, from the form to the core, which seals it and never returns it.
 */
export function TelegramCard({
  server,
  owner,
  onUpdateCore,
}: {
  server: DeployServer;
  owner: boolean;
  /** Opens the core update, for a server whose core does not have this feature yet. */
  onUpdateCore?: (() => void) | undefined;
}): React.JSX.Element {
  const serverId = server.id;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.deployTelegram(serverId),
    queryFn: () => window.runova.deployTelegram.status(serverId),
    retry: false,
  });
  const stepUp = useProofStepUp(server);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<DeployTelegramTestResult | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  function settled(next: DeployTelegramStatus): void {
    queryClient.setQueryData(queryKeys.deployTelegram(serverId), next);
    setTested(null);
    setProblems([]);
  }

  async function save(values: TelegramValues): Promise<boolean> {
    setBusy('save');
    setProblems([]);
    try {
      const result = await stepUp.run(
        (proof) => window.runova.deployTelegram.save({ serverId, ...values, ...proof }),
        'change Telegram alerts',
      );
      if (!result) return false;
      if (result.problems.length > 0 || !result.status) {
        setProblems(result.problems);
        return false;
      }
      settled(result.status);
      toast.success(
        result.status.enabled
          ? `Telegram alerts are on. ${server.nickname} sends to chat ${result.status.chatId}.`
          : 'Telegram alerts are saved and paused.',
      );
      return true;
    } catch (error) {
      toast.error(coreErrorMessage(error));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Stop sending alerts from ${server.nickname} to Telegram?`,
      description:
        'The core forgets the bot token and stops sending. Messages already in the chat stay, and you can set it up again with the token.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setBusy('remove');
    try {
      const next = await stepUp.run(
        (proof) => window.runova.deployTelegram.remove({ serverId, ...proof }),
        'remove Telegram alerts',
      );
      if (!next) return;
      settled(next);
      toast.success('Telegram alerts were removed.');
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function sendTest(): Promise<void> {
    setTesting(true);
    setTested(null);
    try {
      setTested(await window.runova.deployTelegram.test(serverId));
      void query.refetch();
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setTesting(false);
    }
  }

  async function detect(botToken: string): Promise<DeployTelegramDetectResult | null> {
    try {
      return await window.runova.deployTelegram.detectChat(botToken);
    } catch (error) {
      toast.error(coreErrorMessage(error));
      return null;
    }
  }

  const status = query.data;
  return (
    <div className="space-y-2">
      <TelegramStatusCard
        query={query}
        owner={owner}
        tested={tested}
        testing={testing}
        onTest={() => void sendTest()}
        onUpdateCore={onUpdateCore}
      />
      {owner && query.isPending && (
        <SecurityCard icon={<Pencil />} title="Settings" tone="neutral">
          <div className={`${CARD_BODY} space-y-3`} aria-busy="true">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        </SecurityCard>
      )}
      {owner && status && (
        <SecurityCard
          icon={<Pencil />}
          title="Settings"
          tone="neutral"
          description={
            status.configured
              ? 'Change the chat, the name or the alerts. Leave the token empty to keep the one on the server.'
              : 'Paste the bot token, pick the chat and the alerts, and turn it on. The core starts sending at once, with no restart.'
          }
        >
          <div className={CARD_BODY}>
            <TelegramForm
              // A saved change starts the form again from what the core now holds, and empties the token.
              key={`${status.configured}-${status.changedAtUnixMs ?? 'never'}`}
              status={status}
              nickname={server.nickname}
              busy={busy}
              problems={problems}
              onSubmit={save}
              onRemove={() => void remove()}
              onDetect={detect}
            />
          </div>
        </SecurityCard>
      )}
      {stepUp.dialog}
    </div>
  );
}
