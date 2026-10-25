import type { GenerationView } from '@agentmat/studio';
import { useEffect, useState } from 'react';
import { AskAiBar } from '../ai/AskAiBar';
import { BriefCard } from '../ai/BriefCard';
import type { BriefValue } from '../ai/BriefFields';
import { GenerationCard } from '../ai/GenerationCard';
import { GenerationDetailsDialog } from '../ai/GenerationDetailsDialog';
import { ProposalCard } from '../ai/ProposalCard';
import { fromRunInput, usePendingScenario, useRunSettings } from '../ai/runSettings';
import { SaveRecipeDialog } from '../ai/SaveRecipeDialog';
import { useStudioAi } from '../ai/useStudioAi';
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
  SEGMENT_TRACK,
  SimpleTooltip,
  Skeleton,
  segmentClass,
  TOOLBAR,
  toast,
  Undo,
  Video,
} from '../kit';
import { RenderDialog } from '../render/RenderDialog';
import { RenderStrip } from '../render/RenderStrip';
import { SceneCodeDialog } from '../scenes/SceneCodeDialog';
import { SceneMotion } from '../scenes/SceneMotion';
import { TimelineView } from '../timeline/TimelineView';
import { VoicePanel } from '../voice/VoicePanel';
import { HistoryPanel } from './HistoryPanel';
import { LockedCard } from './LockedCard';
import { ScenarioPanel } from './ScenarioPanel';
import { useStudioVideo } from './useStudioVideo';

export interface StudioEditorProps {
  videoId: string;
  onBack: () => void;
  onOpenDevSetup: () => void;
}

/** True when a key press belongs to a text field, which keeps its own undo. */
function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

const SHOWN_WHEN = new Set<GenerationView['status']>(['running', 'failed', 'interrupted']);

const VIEW_LABELS = { scenario: 'Scenario', voice: 'Voice', timeline: 'Timeline' } as const;

/**
 * One video, open for editing: the scenario written by AI from a brief or by hand, edited by hand
 * or by asking AI, with the full history kept. The preview and timeline arrive in the following
 * epics, in panels of their own, each behind its own error boundary so one failing panel never
 * takes the editor down.
 */
export function StudioEditor({
  videoId,
  onBack,
  onOpenDevSetup,
}: StudioEditorProps): React.JSX.Element {
  const video = useStudioVideo(videoId);
  const { view } = video;
  const ai = useStudioAi(videoId, video.adopt);
  const [scenarioRun, setScenarioRun] = useRunSettings('scenario');
  const [editRun, setEditRun] = useRunSettings('edit');
  const [sceneRun, setSceneRun] = useRunSettings('scene');
  const [codeSceneId, setCodeSceneId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [recipeFrom, setRecipeFrom] = useState<GenerationView | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [showHistory, setShowHistory] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [mode, setMode] = useState<'scenario' | 'voice' | 'timeline'>('scenario');
  const [title, setTitle] = useState('');
  const openTitle = view.state === 'open' ? view.document.title : '';
  useEffect(() => setTitle(openTitle), [openTitle]);

  // A scenario asked for in the New video dialog starts once the video is open here.
  const takePending = usePendingScenario((state) => state.take);
  const isOpen = view.state === 'open';
  const { startScenario } = ai;
  useEffect(() => {
    if (!isOpen) return;
    const request = takePending(videoId);
    if (request) void startScenario(request);
  }, [isOpen, takePending, videoId, startScenario]);

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
  const latest = ai.generations[0];
  const proposal = ai.generations.find((g) => g.status === 'proposed');
  const lastScenario = ai.generations.find((g) => g.stage === 'scenario');
  const briefInitial: BriefValue = lastScenario
    ? {
        brief: lastScenario.instruction,
        targetSeconds: lastScenario.params.targetSeconds ?? 60,
        styleId: lastScenario.params.styleId ?? document.styleId,
        run: fromRunInput(lastScenario),
      }
    : { brief: '', targetSeconds: 60, styleId: document.styleId, run: scenarioRun };
  const hasScenes = document.scenario.scenes.length > 0;
  const busy = ai.running !== null;
  const applyProposal = async (generationId: string) => {
    setApplying(true);
    try {
      await ai.applyProposal(generationId);
    } finally {
      setApplying(false);
    }
  };

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
        <div className={SEGMENT_TRACK} role="radiogroup" aria-label="View">
          {(['scenario', 'voice', 'timeline'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              className={segmentClass(mode === value)}
              onClick={() => setMode(value)}
            >
              {VIEW_LABELS[value]}
            </button>
          ))}
        </div>
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
          <Button size="sm" onClick={() => setRendering(true)}>
            <Video /> Render
          </Button>
        </div>
      </div>
      <ErrorBoundary title="Render">
        <RenderStrip videoId={videoId} onOpen={() => setRendering(true)} />
      </ErrorBoundary>
      <Notice tone="neutral" size="sm">
        Every change is saved as you make it, and the full history is kept in the video's own
        folder.
      </Notice>
      <ErrorBoundary title="AI">
        {hasScenes && (
          <AskAiBar
            run={editRun}
            onRunChange={setEditRun}
            busy={busy}
            onAsk={(instruction) => ai.startEdit(instruction, editRun)}
          />
        )}
        {latest && SHOWN_WHEN.has(latest.status) && !dismissed.has(latest.id) && (
          <GenerationCard
            generation={latest}
            output={ai.output[latest.id] ?? []}
            onCancel={() => void ai.cancel(latest.id)}
            onRetry={() => void ai.retry(latest.id)}
            onDetails={() => setDetailsId(latest.id)}
            onDismiss={() => setDismissed((ids) => new Set(ids).add(latest.id))}
          />
        )}
        {proposal && (
          <ProposalCard
            generation={proposal}
            applying={applying}
            onApply={() => void applyProposal(proposal.id)}
            onDiscard={() => void ai.discardProposal(proposal.id)}
          />
        )}
      </ErrorBoundary>
      {mode === 'voice' && (
        <ErrorBoundary title="Voice">
          <VoicePanel
            videoId={videoId}
            document={document}
            apply={video.apply}
            adopt={video.adopt}
          />
        </ErrorBoundary>
      )}
      {mode === 'timeline' && (
        <ErrorBoundary title="Timeline">
          <TimelineView videoId={videoId} document={document} apply={video.apply} />
        </ErrorBoundary>
      )}
      <div
        className={cn(
          'grid gap-2',
          showHistory && 'lg:grid-cols-[minmax(0,1fr)_20rem]',
          mode !== 'scenario' && 'hidden',
        )}
      >
        <ErrorBoundary title="Scenario">
          <ScenarioPanel
            document={document}
            apply={video.apply}
            brief={
              <BriefCard
                // Starts again from the latest brief once the runs have loaded or a scenario lands.
                key={`${ai.loading}-${hasScenes}-${lastScenario?.id ?? ''}`}
                aspect={document.renderSettings.aspect}
                language={document.language}
                rewriting={hasScenes}
                busy={busy}
                initial={briefInitial}
                onStart={(request, value) => {
                  setScenarioRun(value.run);
                  return ai.startScenario(request);
                }}
              />
            }
            renderMotion={(scene, index) => (
              <SceneMotion
                videoId={videoId}
                document={document}
                scene={scene}
                index={index}
                busy={busy}
                run={sceneRun}
                onRunChange={setSceneRun}
                onAnimate={(instruction) => ai.startScene(scene.id, sceneRun, instruction)}
                onOpenCode={() => setCodeSceneId(scene.id)}
              />
            )}
          />
        </ErrorBoundary>
        {showHistory && (
          <ErrorBoundary title="History">
            <HistoryPanel
              videoId={videoId}
              currentSeq={view.status.seq}
              onRestore={(seq) => void video.restore(seq)}
              ai={{
                generations: ai.generations,
                loading: ai.loading,
                onDetails: setDetailsId,
                onRetry: (id) => void ai.retry(id),
                onSaveRecipe: setRecipeFrom,
              }}
            />
          </ErrorBoundary>
        )}
      </div>
      <GenerationDetailsDialog
        videoId={videoId}
        generationId={detailsId}
        onOpenChange={(open) => !open && setDetailsId(null)}
      />
      <SceneCodeDialog
        videoId={videoId}
        sceneId={codeSceneId}
        sceneNumber={document.scenario.scenes.findIndex((s) => s.id === codeSceneId) + 1}
        onOpenChange={(open) => !open && setCodeSceneId(null)}
        onChanged={(result) => void video.adopt(result)}
      />
      <RenderDialog
        videoId={videoId}
        document={document}
        seq={view.status.seq}
        open={rendering}
        onOpenChange={setRendering}
        apply={video.apply}
        onOpenDevSetup={onOpenDevSetup}
      />
      <SaveRecipeDialog
        generation={recipeFrom}
        document={document}
        onOpenChange={(open) => !open && setRecipeFrom(null)}
      />
    </div>
  );
}
