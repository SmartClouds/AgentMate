import { useEffect, useState } from 'react';
import { studioClient } from '../client';
import { errorMessage, scriptClass } from '../format';
import {
  ArrowLeft,
  Button,
  cn,
  EmptyState,
  ErrorBoundary,
  FolderOpen,
  History,
  Input,
  LoadFailure,
  Notice,
  Redo,
  SimpleTooltip,
  Skeleton,
  TOOLBAR,
  toast,
  Undo,
} from '../kit';
import { HistoryPanel } from './HistoryPanel';
import { LockedCard } from './LockedCard';
import { ScenarioPanel } from './ScenarioPanel';
import { useStudioVideo } from './useStudioVideo';

export interface StudioEditorProps {
  videoId: string;
  onBack: () => void;
}

/** True when a key press belongs to a text field, which keeps its own undo. */
function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * One video, open for editing. E31 edits the scenario by hand and keeps the full history; the
 * preview, timeline and AI arrive in the following epics, in panels of their own, each behind its
 * own error boundary so one failing panel never takes the editor down.
 */
export function StudioEditor({ videoId, onBack }: StudioEditorProps): React.JSX.Element {
  const video = useStudioVideo(videoId);
  const { view } = video;
  const [showHistory, setShowHistory] = useState(true);
  const [title, setTitle] = useState('');
  const openTitle = view.state === 'open' ? view.document.title : '';
  useEffect(() => setTitle(openTitle), [openTitle]);

  const status = view.state === 'open' ? view.status : null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || typingInField(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey && status?.canUndo) {
        event.preventDefault();
        void video.undo();
      } else if (((key === 'z' && event.shiftKey) || key === 'y') && status?.canRedo) {
        event.preventDefault();
        void video.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, video]);

  const back = (
    <Button variant="ghost" size="sm" onClick={onBack} className="px-2.5">
      <ArrowLeft /> Studio
    </Button>
  );

  if (view.state === 'loading') {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Opening the video">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (view.state === 'locked') {
    return (
      <div className="space-y-2">
        {back}
        <LockedCard
          holder={view.holder}
          stale={view.stale}
          onTakeOver={() => void video.takeOver()}
          onRetry={() => void video.reload()}
        />
      </div>
    );
  }
  if (view.state === 'missing') {
    return (
      <div className="space-y-2">
        {back}
        <EmptyState
          card
          icon={FolderOpen}
          title="This video's folder is gone"
          description={`It was in ${view.video.folder}. If it was moved or renamed, find it from the Studio library with Locate.`}
          action={<Button onClick={onBack}>Back to Studio</Button>}
        />
      </div>
    );
  }
  if (view.state === 'error') {
    return (
      <div className="space-y-2">
        {back}
        <LoadFailure
          message={`The video did not open. ${view.message}`}
          retry={() => void video.reload()}
        />
      </div>
    );
  }

  const { document } = view;
  const saveTitle = () => {
    const next = title.trim();
    if (!next) {
      setTitle(document.title);
      return;
    }
    if (next !== document.title)
      void video.apply([{ op: 'doc.set', field: 'title', value: next }], 'Renamed the video');
  };

  return (
    <div className="flex flex-col gap-2">
      <div className={TOOLBAR}>
        {back}
        <Input
          aria-label="Video title"
          value={title}
          dir="auto"
          maxLength={200}
          className={cn('h-8 max-w-md flex-1 font-semibold', scriptClass(title))}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={saveTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <div className="ml-auto flex items-center gap-1">
          <SimpleTooltip
            label={
              view.status.undoLabel ? `Undo: ${view.status.undoLabel} (Ctrl+Z)` : 'Nothing to undo'
            }
          >
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Undo"
                disabled={!view.status.canUndo}
                onClick={() => void video.undo()}
              >
                <Undo />
              </Button>
            </span>
          </SimpleTooltip>
          <SimpleTooltip
            label={
              view.status.redoLabel
                ? `Redo: ${view.status.redoLabel} (Ctrl+Shift+Z)`
                : 'Nothing to redo'
            }
          >
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Redo"
                disabled={!view.status.canRedo}
                onClick={() => void video.redo()}
              >
                <Redo />
              </Button>
            </span>
          </SimpleTooltip>
          <SimpleTooltip label="Open the video's folder">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open the video's folder"
              onClick={() =>
                void studioClient()
                  .revealVideo(videoId)
                  .catch((error: unknown) => toast.error(errorMessage(error)))
              }
            >
              <FolderOpen />
            </Button>
          </SimpleTooltip>
          <Button
            variant={showHistory ? 'tint' : 'ghost'}
            size="sm"
            aria-pressed={showHistory}
            onClick={() => setShowHistory((open) => !open)}
          >
            <History /> History
          </Button>
        </div>
      </div>
      <Notice tone="neutral" size="sm">
        Every change is saved as you make it, and the full history is kept in the video's own
        folder.
      </Notice>
      <div className={cn('grid gap-2', showHistory && 'lg:grid-cols-[minmax(0,1fr)_20rem]')}>
        <ErrorBoundary title="Scenario">
          <ScenarioPanel document={document} apply={video.apply} />
        </ErrorBoundary>
        {showHistory && (
          <ErrorBoundary title="History">
            <HistoryPanel
              videoId={videoId}
              currentSeq={view.status.seq}
              onRestore={(seq) => void video.restore(seq)}
            />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
