import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployAssistantChatSummary } from '@shared/deployAssistantTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { groupByDay } from '@/components/agentHistory/historyFilters';
import { ArrowLeft, Package, Trash2 } from '@/components/icons';
import { Chip, type ChipTone, SearchPill } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

/**
 * The server's past Deploy AI chats, inside the drawer (so the logs beside it stay in view). They
 * are grouped by day and can be searched by what was asked; picking one shows it in the drawer,
 * ready to carry on. A chat can be deleted after a confirm. The history outlives the app, so a
 * chat from yesterday is still here after a restart.
 */

const STATUS: Record<DeployAssistantChatSummary['status'], { label: string; tone: ChipTone }> = {
  finished: { label: 'Finished', tone: 'success' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  error: { label: 'Failed', tone: 'destructive' },
  running: { label: 'Running', tone: 'primary' },
  paused: { label: 'Paused', tone: 'warning' },
};

function when(at: number, today: boolean): string {
  const date = new Date(at);
  return today
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ChatRow({
  chat,
  today,
  current,
  onOpen,
  onDelete,
}: {
  chat: DeployAssistantChatSummary;
  today: boolean;
  current: boolean;
  onOpen: () => void;
  onDelete: () => Promise<void>;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const status = STATUS[chat.status];

  if (confirming) {
    return (
      <li>
        <div
          role="group"
          aria-label="Delete this chat?"
          className="flex flex-wrap items-center gap-2 rounded-xl bg-destructive/8 px-3 py-2.5 ring-1 ring-inset ring-destructive/25"
        >
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-medium">Delete this chat?</span>{' '}
            <span className="text-muted-foreground">It goes from this computer for good.</span>
          </p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="danger"
              disabled={deleting}
              onClick={() => {
                setDeleting(true);
                void onDelete().finally(() => {
                  setDeleting(false);
                  setConfirming(false);
                });
              }}
            >
              Delete
            </Button>
            <Button size="sm" variant="soft" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="group relative">
      <button
        type="button"
        aria-current={current ? 'true' : undefined}
        onClick={onOpen}
        className={cn(
          'w-full cursor-pointer space-y-1.5 rounded-xl px-3 py-2.5 pr-10 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          current && 'bg-primary/[0.06] ring-1 ring-inset ring-primary/25',
        )}
      >
        <span className="line-clamp-2 block min-w-0 break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">
          {chat.title}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span>{when(chat.updatedAt, today)}</span>
          <span aria-hidden>·</span>
          <span>
            {chat.turns} {chat.turns === 1 ? 'question' : 'questions'}
          </span>
          <Chip dot tone={status.tone}>
            {status.label}
          </Chip>
          {chat.app && (
            <Chip className="min-w-0 max-w-40" title={chat.app.name}>
              <Package />
              <span className="truncate">{chat.app.name}</span>
            </Chip>
          )}
          {current && <Chip tone="primary">Open now</Chip>}
        </span>
      </button>
      <SimpleTooltip label="Delete chat">
        <button
          type="button"
          aria-label={`Delete chat: ${chat.title}`}
          onClick={() => setConfirming(true)}
          className="absolute right-2 top-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-focus-within:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </SimpleTooltip>
    </li>
  );
}

export function AssistantHistory({
  serverId,
  currentRunId,
  onOpen,
  onBack,
  onDeleted,
}: {
  serverId: string;
  /** The newest run of the chat on screen, marked in the list. */
  currentRunId?: string;
  onOpen: (chat: DeployAssistantChatSummary) => void;
  onBack: () => void;
  onDeleted?: (runId: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const queryClient = useQueryClient();
  const chats = useQuery({
    queryKey: queryKeys.deployAssistantChats(serverId),
    queryFn: () => window.runova.deployAssistant.chats(serverId),
    // Runs end and chats grow while the list is closed, so it reads them again each time.
    refetchOnMount: 'always',
  });
  const needle = query.trim().toLowerCase();
  const shown = (chats.data ?? []).filter(
    (chat) => !needle || chat.title.toLowerCase().includes(needle),
  );
  const now = new Date();
  const groups = groupByDay(shown, now);

  async function remove(runId: string): Promise<void> {
    try {
      await window.runova.deployAssistant.deleteChat({ serverId, runId });
      onDeleted?.(runId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.deployAssistantChats(serverId) });
    } catch (error) {
      toast.error(coreErrorMessage(error));
    }
  }

  return (
    <section aria-label="Chat history" className="min-w-0 space-y-3">
      <div className="flex items-center gap-2">
        <SimpleTooltip label="Back to the chat">
          <Button size="icon-sm" variant="ghost" aria-label="Back to the chat" onClick={onBack}>
            <ArrowLeft />
          </Button>
        </SimpleTooltip>
        <h3 className="text-sm font-semibold text-foreground">Chat history</h3>
      </div>
      <SearchPill
        type="search"
        value={query}
        onValueChange={setQuery}
        label="Search chats"
        clearLabel="Clear search"
        placeholder="Search what you asked"
        className="w-full"
      />

      {chats.isPending ? (
        <div aria-label="Loading chats" aria-busy="true" className="space-y-2">
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
      ) : chats.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {coreErrorMessage(chats.error)}
        </p>
      ) : (chats.data ?? []).length === 0 ? (
        <p className="rounded-xl bg-foreground/[0.03] px-3 py-6 text-center text-sm text-muted-foreground">
          No chats on this server yet. What you ask the AI shows up here, so you can read it again
          or carry it on.
        </p>
      ) : groups.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">No chat matches that.</p>
      ) : (
        groups.map((group) => (
          <div key={group.label} role="group" aria-label={group.label} className="space-y-1">
            <h4 className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {group.label}
            </h4>
            <ul className="space-y-0.5">
              {group.items.map((chat) => (
                <ChatRow
                  key={chat.runId}
                  chat={chat}
                  today={group.label === 'Today'}
                  current={chat.runId === currentRunId}
                  onOpen={() => onOpen(chat)}
                  onDelete={() => remove(chat.runId)}
                />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
