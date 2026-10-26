import type { ProposalChange } from '@agentmat/studio';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ChangeItem } from '../ai/ProposalCard';
import { studioClient } from '../client';
import { errorMessage } from '../format';
import {
  Button,
  Code,
  Combobox,
  confirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  History,
  LoadFailure,
  Skeleton,
  Spinner,
  toast,
} from '../kit';
import { TextDiff } from './TextDiff';

export interface CompareVersionsDialogProps {
  videoId: string;
  /** The older version; null keeps the dialog closed. */
  from: number | null;
  /** The version it is compared with, the current one at first. */
  to: number;
  onOpenChange: (open: boolean) => void;
  onRestore: (seq: number) => void;
  /** Opens a video, the one a branch made. */
  onOpenVideo?: (videoId: string) => void;
}

type CodeChange = { scene: string; before: string; after: string };

/** The scenes whose animation code changed, with the two code trees to compare. */
function codeChanges(changes: ProposalChange[]): CodeChange[] {
  return changes.flatMap((change) => {
    if (change.kind !== 'scene-changed') return [];
    const code = change.changes.find((c) => c.field === 'code');
    if (!code || code.before === 'none' || code.after === 'none') return [];
    return [
      {
        scene: `Scene ${change.position}: ${change.title}`,
        before: code.before,
        after: code.after,
      },
    ];
  });
}

function CodeCompare({
  videoId,
  change,
}: {
  videoId: string;
  change: CodeChange;
}): React.JSX.Element {
  const before = useQuery({
    queryKey: ['studio', 'tree-files', videoId, change.before],
    queryFn: () => studioClient().treeFiles(videoId, change.before),
  });
  const after = useQuery({
    queryKey: ['studio', 'tree-files', videoId, change.after],
    queryFn: () => studioClient().treeFiles(videoId, change.after),
  });
  const paths = [
    ...new Set(
      [...(before.data ?? []), ...(after.data ?? [])]
        .filter((f) => f.text !== null)
        .map((f) => f.path),
    ),
  ].sort();
  const [path, setPath] = useState('');
  useEffect(() => {
    if (!paths.includes(path)) setPath(paths.find((p) => p.endsWith('.js')) ?? paths[0] ?? '');
  }, [paths, path]);
  if (before.isLoading || after.isLoading) return <Skeleton className="h-80 w-full" />;
  if (before.error || after.error) {
    return <p className="text-sm text-destructive">{errorMessage(before.error ?? after.error)}</p>;
  }
  const text = (files: typeof before.data, p: string) =>
    files?.find((f) => f.path === p)?.text ?? '';
  return (
    <div className="space-y-2">
      <Combobox
        ariaLabel="File"
        searchable={false}
        value={path}
        onChange={setPath}
        options={paths.map((p) => ({ value: p, label: p }))}
      />
      {path && (
        <TextDiff
          path={path}
          original={text(before.data, path)}
          modified={text(after.data, path)}
        />
      )}
    </div>
  );
}

/**
 * Two versions of a video side by side (E39): what changed in the scenario, the scenes, the clips
 * and the tracks, the animation code of a changed scene in a diff, and from here the older version
 * can be restored or started as a new video.
 */
export function CompareVersionsDialog({
  videoId,
  from,
  to,
  onOpenChange,
  onRestore,
  onOpenVideo,
}: CompareVersionsDialogProps): React.JSX.Element {
  const open = from !== null;
  const [codeOf, setCodeOf] = useState<CodeChange | null>(null);
  const [branching, setBranching] = useState(false);
  const changes = useQuery({
    queryKey: ['studio', 'compare', videoId, from, to],
    queryFn: () => studioClient().compareVersions(videoId, from as number, to),
    enabled: open,
  });
  useEffect(() => {
    if (!open) setCodeOf(null);
  }, [open]);
  const code = codeChanges(changes.data ?? []);

  async function restore() {
    if (from === null) return;
    const ok = await confirmDialog({
      title: `Go back to version ${from}?`,
      description: 'This is added as a new change, so nothing after it is lost.',
      confirmLabel: 'Restore this version',
    });
    if (!ok) return;
    onRestore(from);
    onOpenChange(false);
  }

  async function branch() {
    if (from === null) return;
    setBranching(true);
    try {
      const made = await studioClient().branch(videoId, from);
      toast.success(`Started "${made.title}" from version ${from}.`);
      onOpenChange(false);
      onOpenVideo?.(made.id);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBranching(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Version {from} and version {to}
          </DialogTitle>
          <DialogDescription>
            What changed from the older version to the newer one.
          </DialogDescription>
        </DialogHeader>
        {changes.isLoading && <Skeleton className="h-40 w-full" />}
        {changes.error && (
          <LoadFailure
            message={`The two versions could not be compared. ${errorMessage(changes.error)}`}
            retry={() => void changes.refetch()}
          />
        )}
        {changes.data?.length === 0 && (
          <EmptyState
            icon={History}
            size="sm"
            title="The same"
            description="These two versions have the same scenario, scenes and timeline."
          />
        )}
        {codeOf ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">
                Code of {codeOf.scene}
              </p>
              <Button size="sm" variant="ghost" onClick={() => setCodeOf(null)}>
                Back to the changes
              </Button>
            </div>
            <CodeCompare videoId={videoId} change={codeOf} />
          </div>
        ) : (
          <ul aria-label="Changes" className="max-h-[50vh] space-y-3 overflow-y-auto">
            {(changes.data ?? []).map((change, k) => (
              <li key={`${change.kind}-${k}`} className="space-y-1">
                <ChangeItem change={change} />
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {!codeOf &&
            code.map((c) => (
              <Button key={c.scene} size="sm" variant="soft" onClick={() => setCodeOf(c)}>
                <Code /> Code of {c.scene}
              </Button>
            ))}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" disabled={branching} onClick={() => void branch()}>
              {branching && <Spinner />} Start a new video from version {from}
            </Button>
            <Button size="sm" onClick={() => void restore()}>
              Restore version {from}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
