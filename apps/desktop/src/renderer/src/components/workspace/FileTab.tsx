import type { Project } from '@agentmat/core';
import { isImagePath, isTextImagePath } from '@shared/imageFiles';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { languageFor } from '@/components/editor/MonacoDiffEditor';
import { MonacoEditor } from '@/components/editor/MonacoEditor';
import { ExternalLink, File, ImageIcon, RefreshCw, Save, Spinner } from '@/components/icons';
import { Chip, EmptyState } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useEditorRevealStore } from '@/stores/editorRevealStore';
import { setFileDirty } from '@/stores/explorerStore';
import { useWorkspaceStore, type WorkspaceFileTab } from '@/stores/workspaceStore';
import { ImageFileTab } from './ImageFileTab';

/** Files past this open read-only: Monaco copes, but editing a multi-megabyte file here is a trap. */
const MAX_EDITABLE_CHARS = 2_000_000;

export function fileQueryKey(path: string): readonly unknown[] {
  return queryKeys.workspaceFile(path);
}

/**
 * A project file in a tab. A picture opens in the viewer; everything else, including an SVG
 * the viewer was asked to hand over, opens in the editor.
 */
export default function FileTab({
  project,
  tab,
}: {
  project: Project;
  tab: WorkspaceFileTab;
}): React.JSX.Element {
  const [asText, setAsText] = useState(false);

  // Reusing the tab for another file starts back at the viewer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path is the trigger, not a read
  useEffect(() => {
    setAsText(false);
  }, [tab.path]);

  // A preview tab keeps its id while the file in it changes, so each file gets fresh state
  // (draft, save, image size) instead of inheriting the last one's.
  if (isImagePath(tab.path) && !asText) {
    return (
      <ImageFileTab
        key={tab.path}
        project={project}
        tab={tab}
        onEditSource={isTextImagePath(tab.path) ? () => setAsText(true) : undefined}
      />
    );
  }
  return (
    <TextFileTab
      key={tab.path}
      project={project}
      tab={tab}
      onShowImage={isImagePath(tab.path) ? () => setAsText(false) : undefined}
    />
  );
}

/** A file in an editor: Ctrl+S saves, and a clean file follows changes on disk. */
function TextFileTab({
  project,
  tab,
  onShowImage,
}: {
  project: Project;
  tab: WorkspaceFileTab;
  /** Set for an image shown as source, to go back to the picture. */
  onShowImage?: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const openFile = useWorkspaceStore((s) => s.openFile);
  const file = useQuery({
    queryKey: fileQueryKey(tab.path),
    queryFn: () => window.agentmat.fs.readFile(tab.path),
    meta: { silentLoading: true },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dirty = draft !== null && draft !== file.data;
  const tooLarge = (file.data?.length ?? 0) > MAX_EDITABLE_CHARS;
  // A search result opened here asks for its line; the editor takes it once it has the text.
  const reveal = useEditorRevealStore((s) => s.pending[tab.path] ?? null);
  const takeReveal = useCallback(
    () => void useEditorRevealStore.getState().takeReveal(tab.path),
    [tab.path],
  );

  // The explorer warns before deleting a file that has unsaved edits here.
  useEffect(() => {
    setFileDirty(tab.path, dirty);
    return () => setFileDirty(tab.path, false);
  }, [tab.path, dirty]);

  const relative = tab.path.startsWith(project.folderPath)
    ? tab.path.slice(project.folderPath.length).replace(/^[\\/]/, '')
    : tab.path;
  const parts = relative.split(/[\\/]/);
  const name = parts.pop() ?? relative;
  const dir = parts.join('/');

  async function save(): Promise<void> {
    if (!dirty || draft === null || saving) return;
    setSaving(true);
    try {
      await window.agentmat.fs.writeFile(tab.path, draft);
      queryClient.setQueryData(fileQueryKey(tab.path), draft);
      setDraft(null);
    } catch (error) {
      toast.error('Could not save the file', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  }

  // Ctrl/Cmd+S saves while focus is anywhere in this tab.
  // biome-ignore lint/correctness/useExhaustiveDependencies: save reads the latest draft
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.code === 'KeyS') {
        event.preventDefault();
        event.stopPropagation();
        void save();
      }
    };
    el.addEventListener('keydown', onKeyDown, true);
    return () => el.removeEventListener('keydown', onKeyDown, true);
  }, [draft, file.data, saving]);

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
        <File className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="min-w-[3rem] shrink truncate text-xs font-medium">{name}</span>
        {dir ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground [direction:rtl]">
            <bdi>{dir}</bdi>
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {dirty ? (
          <Chip tone="warning" dot>
            Unsaved
          </Chip>
        ) : null}
        {onShowImage ? (
          <SimpleTooltip label="Show the picture">
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label="Show the picture"
              onClick={onShowImage}
            >
              <ImageIcon />
            </Button>
          </SimpleTooltip>
        ) : null}
        <SimpleTooltip label="Reload from disk">
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Reload from disk"
            onClick={() => {
              setDraft(null);
              void file.refetch();
            }}
          >
            <RefreshCw className={cn('h-2.5 w-2.5', file.isFetching && 'animate-spin')} />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Open in its default app">
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Open in its default app"
            onClick={() => void window.agentmat.shell.openPath(tab.path)}
          >
            <ExternalLink />
          </Button>
        </SimpleTooltip>
        <Button type="button" size="xs" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? <Spinner className="animate-spin" /> : <Save />}
          Save
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {file.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton
                key={i}
                className="h-3.5 rounded"
                style={{ width: `${35 + ((i * 41) % 60)}%` }}
              />
            ))}
          </div>
        ) : file.isError ? (
          <EmptyState
            size="sm"
            icon={File}
            title="This file could not be opened"
            description={
              file.error instanceof Error
                ? file.error.message
                : 'It may have been moved or deleted.'
            }
            className="h-full"
          />
        ) : (
          <MonacoEditor
            value={draft ?? file.data ?? ''}
            onChange={(value) => {
              setDraft(value);
              // Editing a preview tab keeps it, so the edit isn't lost to the next file clicked.
              if (tab.preview) openFile(project.id, tab.path, { pin: true });
            }}
            language={languageFor(tab.path.replaceAll('\\', '/'))}
            readOnly={tooLarge}
            reveal={reveal}
            onRevealed={takeReveal}
            className="absolute inset-0 min-h-0 rounded-none border-0"
          />
        )}
      </div>
    </div>
  );
}
