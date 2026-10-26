import type { EditResponse, SceneCheckView } from '@runova/studio';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import { studioScenesClient } from '../client';
import { errorMessage, formatWhen } from '../format';
import {
  Button,
  Chip,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  LoadFailure,
  MonacoEditor,
  Notice,
  Save,
  SEGMENT_TRACK,
  Skeleton,
  segmentClass,
  toast,
} from '../kit';
import { studioKeys } from '../queryKeys';

const LANGUAGES: Record<string, string> = {
  html: 'html',
  js: 'javascript',
  mjs: 'javascript',
  css: 'css',
  json: 'json',
  svg: 'xml',
  txt: 'plaintext',
};

export interface SceneCodeDialogProps {
  videoId: string;
  sceneId: string | null;
  sceneNumber: number;
  onOpenChange: (open: boolean) => void;
  /** A save or a revision change made a new version of the video. */
  onChanged: (result: EditResponse) => void;
}

/**
 * The code of one scene: its files to read and edit, every earlier version to go back to, and a
 * check of the current one. Saving makes a new version; nothing is ever overwritten.
 */
export function SceneCodeDialog({
  videoId,
  sceneId,
  sceneNumber,
  onOpenChange,
  onChanged,
}: SceneCodeDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const open = sceneId !== null;
  const code = useQuery({
    queryKey: studioKeys.sceneCode(videoId, sceneId ?? ''),
    queryFn: () => studioScenesClient().code(videoId, sceneId as string),
    enabled: open,
  });
  const textFiles = (code.data?.files ?? []).filter((f) => f.text !== null);
  const [path, setPath] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<SceneCheckView | null>(null);
  const [checking, setChecking] = useState(false);
  // A Monaco editor made inside a dialog that is still animating open takes no typing; it is
  // mounted two frames after the dialog opens instead.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!open) {
      setMounted(false);
      setDrafts({});
      setCheck(null);
      return;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setMounted(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [open]);

  const current =
    path && textFiles.some((f) => f.path === path) ? path : (textFiles[0]?.path ?? null);
  const file = textFiles.find((f) => f.path === current);
  const value = current ? (drafts[current] ?? file?.text ?? '') : '';
  const dirty = Object.entries(drafts).filter(
    ([p, text]) => textFiles.find((f) => f.path === p)?.text !== text,
  );

  const refresh = async (result: EditResponse) => {
    onChanged(result);
    setDrafts({});
    await queryClient.invalidateQueries({ queryKey: studioKeys.sceneCode(videoId, sceneId ?? '') });
  };

  const save = async () => {
    if (!sceneId || dirty.length === 0 || saving) return;
    setSaving(true);
    try {
      const result = await studioScenesClient().saveFiles({
        videoId,
        sceneId,
        files: dirty.map(([p, content]) => ({ path: p, content })),
      });
      await refresh(result);
      toast.success('Saved as a new version of the scene.');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const restoreRevision = async (revisionId: number) => {
    if (!sceneId) return;
    try {
      await refresh(await studioScenesClient().useRevision(videoId, sceneId, revisionId));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const runCheck = async () => {
    if (!sceneId) return;
    setChecking(true);
    try {
      setCheck(await studioScenesClient().check(videoId, sceneId));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Scene {sceneNumber} code</DialogTitle>
          <DialogDescription>
            The scene as a small web page. Saving keeps the old version, so you can always go back.
          </DialogDescription>
        </DialogHeader>
        {code.isPending && (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-80 w-full" />
          </div>
        )}
        {code.error && (
          <LoadFailure
            message={`The code did not load. ${errorMessage(code.error)}`}
            retry={() => void code.refetch()}
          />
        )}
        {code.data && (
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_15rem]">
            <div
              className="min-w-0 space-y-2"
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault();
                  void save();
                }
              }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <div className={SEGMENT_TRACK} role="tablist" aria-label="Files">
                  {textFiles.map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      role="tab"
                      aria-selected={f.path === current}
                      className={segmentClass(f.path === current)}
                      onClick={() => setPath(f.path)}
                    >
                      {f.path}
                      {dirty.some(([p]) => p === f.path) ? ' *' : ''}
                    </button>
                  ))}
                </div>
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={dirty.length === 0 || saving}
                  onClick={() => void save()}
                >
                  <Save /> {saving ? 'Saving...' : 'Save'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={checking}
                  onClick={() => void runCheck()}
                >
                  {checking ? 'Checking...' : 'Check'}
                </Button>
              </div>
              <div className="h-[55vh] overflow-hidden rounded-lg ring-1 ring-inset ring-foreground/10">
                {mounted && current ? (
                  <Suspense fallback={<Skeleton className="h-full w-full" />}>
                    <MonacoEditor
                      key={current}
                      value={value}
                      language={LANGUAGES[current.split('.').pop() ?? ''] ?? 'plaintext'}
                      onChange={(next) => setDrafts((d) => ({ ...d, [current]: next }))}
                      className="h-full"
                    />
                  </Suspense>
                ) : (
                  <Skeleton className="h-full w-full" />
                )}
              </div>
              {check && (
                <Notice tone={check.ok ? 'success' : 'destructive'} size="sm">
                  {check.ok ? (
                    'The scene passes its checks.'
                  ) : (
                    <ul className="list-disc space-y-0.5 pl-4">
                      {check.problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  )}
                </Notice>
              )}
            </div>
            <aside className="min-h-0 space-y-1" aria-label="Versions">
              <p className="text-xs font-medium text-muted-foreground">Versions</p>
              <ol className="max-h-[55vh] space-y-1 overflow-y-auto">
                {code.data.revisions.map((revision) => {
                  const isCurrent = revision.treeHash === code.data?.treeHash;
                  return (
                    <li
                      key={revision.id}
                      className={cn(
                        'rounded-lg px-2 py-1.5 text-xs',
                        isCurrent ? 'bg-primary/10' : 'hover:bg-foreground/[0.04]',
                      )}
                    >
                      <p className="font-medium">{revision.label}</p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Chip tone={revision.author === 'ai' ? 'primary' : 'neutral'}>
                          {revision.author === 'ai' ? 'AI' : 'You'}
                        </Chip>
                        {formatWhen(revision.at)}
                        {isCurrent && <Chip tone="success">Current</Chip>}
                      </p>
                      {!isCurrent && (
                        <Button
                          size="xs"
                          variant="ghost"
                          className="mt-1"
                          onClick={() => void restoreRevision(revision.id)}
                        >
                          Use this version
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ol>
            </aside>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
