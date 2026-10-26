import type { EditResponse, Scene } from '@runova/studio';
import { useEffect, useState } from 'react';
import { studioAudioClient } from '../client';
import { errorMessage, formatSeconds } from '../format';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Microphone,
  Notice,
  persianTextProps,
  Spinner,
  StopCircle,
  toast,
} from '../kit';
import { useNarrationRecorder } from './useNarrationRecorder';

export interface RecordDialogProps {
  videoId: string;
  /** The scene to narrate and its number; null when the dialog is closed. */
  target: { scene: Scene; index: number } | null;
  onOpenChange: (open: boolean) => void;
  onPlaced: (result: EditResponse) => void;
}

/**
 * Records a scene's narration in the user's own voice. The scene's text is shown large while they
 * speak, a meter shows they are heard, and the take can be played back and done again before it
 * goes on the scene.
 */
export function RecordDialog({
  videoId,
  target,
  onOpenChange,
  onPlaced,
}: RecordDialogProps): React.JSX.Element {
  const recorder = useNarrationRecorder();
  const [saving, setSaving] = useState(false);
  const open = target !== null;
  const { reset } = recorder;

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  async function placeTake(): Promise<void> {
    if (!target || !recorder.take) return;
    setSaving(true);
    try {
      const bytes = new Uint8Array(await recorder.take.blob.arrayBuffer());
      const result = await studioAudioClient().record({
        videoId,
        sceneId: target.scene.id,
        bytes,
        mimeType: recorder.take.blob.type || 'audio/webm',
      });
      onPlaced(result);
      toast.success(`Your recording is now the narration of scene ${target.index + 1}.`);
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const narration = target?.scene.narration ?? '';
  const recording = recorder.state === 'recording';

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record scene {target ? target.index + 1 : ''}</DialogTitle>
          <DialogDescription>
            Read the narration below at your own pace. The scene's length follows your recording.
          </DialogDescription>
        </DialogHeader>
        <div
          aria-label="Narration to read"
          className={cn(
            'max-h-64 overflow-y-auto rounded-md border bg-muted/40 p-4 text-xl leading-relaxed',
            persianTextProps(narration).className,
          )}
          dir={persianTextProps(narration).dir ?? 'auto'}
        >
          {narration || 'This scene has no narration yet. Write some in the scenario first.'}
        </div>
        {!recorder.supported && (
          <Notice tone="warning" size="sm">
            This computer cannot record sound here.
          </Notice>
        )}
        {recorder.error && (
          <Notice tone="destructive" size="sm">
            {recorder.error}
          </Notice>
        )}
        <div className="flex items-center gap-3">
          <div
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(recorder.level * 100)}
            className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-75 motion-reduce:transition-none"
              style={{ width: `${Math.round(recorder.level * 100)}%` }}
            />
          </div>
          <span className="w-20 text-right text-sm tabular-nums text-muted-foreground">
            {recording || recorder.take ? formatSeconds(recorder.elapsedSeconds) : ''}
          </span>
        </div>
        {recorder.take && (
          <audio controls src={recorder.take.url} className="w-full" aria-label="Your take" />
        )}
        <DialogFooter>
          {recording ? (
            <Button onClick={recorder.stop}>
              <StopCircle /> Stop
            </Button>
          ) : (
            <Button
              variant={recorder.take ? 'ghost' : 'default'}
              disabled={
                !recorder.supported || !narration || recorder.state === 'starting' || saving
              }
              onClick={() => void recorder.start()}
            >
              <Microphone /> {recorder.take ? 'Record again' : 'Start recording'}
            </Button>
          )}
          {recorder.take && !recording && (
            <Button disabled={saving} onClick={() => void placeTake()}>
              {saving && <Spinner />} Use this take
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
