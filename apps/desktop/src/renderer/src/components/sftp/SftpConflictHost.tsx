import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { type ServerFiles, serverFiles, useSftpStore } from '@/stores/sftpStore';
import { ConflictDialog } from './ConflictDialog';

/**
 * The one "This file already exists" dialog of a window (E25). It sits in the app shell (and in
 * the pop-out window), not in the file manager, so a page plus a docked panel on the same server
 * never stack two modals.
 *
 * It opens by itself only for a server whose files this window shows (a page or a docked panel),
 * or the one the user asked to answer (`requestAnswer`, from the status bar or the toast). A
 * question about a server out of sight would land on a page about something else, with
 * Overwrite focused, where Enter typed into a terminal answers it. Those get a toast with an
 * Answer button instead, one per question, and the status bar item says one waits.
 */

type Servers = Record<string, ServerFiles>;

function nicknameOf(files: ServerFiles): string {
  return files.session?.nickname ?? files.server?.nickname ?? files.serverId;
}

/** The server the dialog asks about: the one picked to answer, else the first shown by id. */
function askingServerId(state: { servers: Servers; conflictFocus: string | null }): string | null {
  const focus = state.conflictFocus;
  if (focus && state.servers[focus]?.queue?.conflict) return focus;
  const shown = Object.keys(state.servers)
    .filter((id) => {
      const files = state.servers[id];
      return Boolean(files?.queue?.conflict) && (files?.visible ?? 0) > 0;
    })
    .sort();
  return shown[0] ?? null;
}

interface WaitingToast {
  id: string;
  serverId: string;
  title: string;
  description: string;
}

const toastId = (conflictId: string): string => `sftp-conflict-${conflictId}`;

/** The questions not in the dialog, as the toasts that tell them. */
function waitingToasts(state: { servers: Servers }, asking: string | null): WaitingToast[] {
  return Object.keys(state.servers)
    .sort()
    .flatMap((serverId) => {
      const files = serverFiles(state, serverId);
      const conflict = files.queue?.conflict;
      if (!conflict || serverId === asking) return [];
      return [
        {
          id: toastId(conflict.conflictId),
          serverId,
          title: `${nicknameOf(files)} needs your answer`,
          description: `${conflict.name} is already in ${conflict.targetDir}.`,
        },
      ];
    });
}

/** Shows a toast per waiting question and takes it down once the question is gone. */
function useWaitingToasts(asking: string | null): void {
  // A string, so a queue snapshot that asks nothing new runs no effect.
  const signature = useSftpStore((state) => JSON.stringify(waitingToasts(state, asking)));
  const shown = useRef(new Set<string>());

  useEffect(() => {
    const wanted = JSON.parse(signature) as WaitingToast[];
    const ids = new Set(wanted.map((entry) => entry.id));
    for (const id of shown.current) {
      if (!ids.has(id)) {
        toast.dismiss(id);
        shown.current.delete(id);
      }
    }
    for (const entry of wanted) {
      if (shown.current.has(entry.id)) continue;
      shown.current.add(entry.id);
      toast.warning(entry.title, {
        id: entry.id,
        description: entry.description,
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: 'Answer',
          onClick: () => useSftpStore.getState().requestAnswer(entry.serverId),
        },
      });
    }
  }, [signature]);

  useEffect(() => {
    const current = shown.current;
    return () => {
      for (const id of current) toast.dismiss(id);
      current.clear();
    };
  }, []);
}

export function SftpConflictHost(): React.JSX.Element | null {
  const serverId = useSftpStore(askingServerId);
  useWaitingToasts(serverId);
  const conflict = useSftpStore((state) =>
    serverId ? (serverFiles(state, serverId).queue?.conflict ?? null) : null,
  );
  // A primitive, so a queue snapshot does not render the dialog again.
  const serverName = useSftpStore((state) =>
    serverId ? nicknameOf(serverFiles(state, serverId)) : undefined,
  );
  const store = useSftpStore.getState;
  if (!serverId) return null;
  return (
    // The store rejects these with main's error, so the dialog tells it and unlocks.
    <ConflictDialog
      conflict={conflict}
      serverName={serverName}
      onResolve={async (decision) => {
        // Read at answer time: the conflict may have moved on since this was drawn.
        const current = serverFiles(store(), serverId).queue?.conflict;
        if (current) await store().resolveConflict(serverId, current.conflictId, decision);
      }}
      onCancelBatch={(batchId) => store().cancel(serverId, { batchId })}
    />
  );
}
