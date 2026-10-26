import {
  type EditOp,
  type EditResponse,
  type NarrationJobView,
  parseVoiceRef,
  RECORDED_VOICE,
  type Scene,
  type StudioDocument,
  type VoiceEngineView,
} from '@runova/studio';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { rememberedVoice } from '../ai/runSettings';
import { studioAudioClient } from '../client';
import { errorMessage } from '../format';
import {
  Button,
  Chip,
  Combobox,
  cn,
  EmptyState,
  GLASS_CARD,
  LoadFailure,
  Lock,
  Microphone,
  Notice,
  Play,
  persianTextProps,
  SECTION_HEADING,
  SimpleTooltip,
  Skeleton,
  Spinner,
  Switch,
  toast,
  VaultUnlockDialog,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { RecordDialog } from './RecordDialog';
import { VoiceProfilesDialog } from './VoiceProfilesDialog';

export interface VoicePanelProps {
  videoId: string;
  document: StudioDocument;
  apply: (ops: EditOp[], label: string) => Promise<boolean>;
  adopt: (result: EditResponse) => Promise<void>;
  /** Opens Dev Setup on Studio's tools, where the local voices install. */
  onOpenDevSetup: () => void;
}

/** "$0.02", or "under a cent", for the estimate before speaking. */
function formatCost(dollars: number): string {
  if (dollars < 0.01) return 'under a cent';
  return `about $${dollars < 10 ? dollars.toFixed(2) : Math.round(dollars)}`;
}

/**
 * The video's narration: each scene spoken by an online voice or recorded by the user, then
 * captioned where its words are spoken. A scene timed by its narration grows or shrinks to fit
 * its voice, and later scenes move along with their voices and captions.
 */
export function VoicePanel({
  videoId,
  document,
  apply,
  adopt,
  onOpenDevSetup,
}: VoicePanelProps): React.JSX.Element {
  const id = useId();
  const queryClient = useQueryClient();
  const engines = useQuery({
    queryKey: studioKeys.voiceEngines,
    queryFn: () => studioAudioClient().engines(),
  });
  // The voice a scene was last spoken with, else the one the video's recipe chose.
  const firstRef = parseVoiceRef(
    document.scenario.scenes.find((s) => s.voiceRef && s.voiceRef !== RECORDED_VOICE)?.voiceRef ??
      rememberedVoice(videoId),
  );
  const [engineId, setEngineId] = useState<VoiceEngineView['id'] | null>(firstRef?.engine ?? null);
  const [voiceId, setVoiceId] = useState<string>(firstRef?.voice ?? '');
  const [unlocking, setUnlocking] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [recordTarget, setRecordTarget] = useState<{ scene: Scene; index: number } | null>(null);
  const [captioning, setCaptioning] = useState<string | null>(null);

  // Until the user picks, the first engine that is ready to use.
  useEffect(() => {
    if (engineId || !engines.data) return;
    setEngineId((engines.data.find((e) => !e.problem) ?? engines.data[0])?.id ?? null);
  }, [engineId, engines.data]);

  const engine = engines.data?.find((e) => e.id === engineId) ?? null;
  const voices = useQuery({
    queryKey: studioKeys.voices(engineId ?? '', document.language),
    queryFn: () => studioAudioClient().voices(engineId as VoiceEngineView['id'], document.language),
    enabled: !!engine && !engine.problem,
  });
  useEffect(() => {
    if (!voices.data?.length) return;
    if (!voices.data.some((v) => v.id === voiceId)) setVoiceId(voices.data[0]?.id ?? '');
  }, [voices.data, voiceId]);

  const jobs = useQuery({
    queryKey: studioKeys.narrationJobs(videoId),
    queryFn: () => studioAudioClient().jobs(videoId),
  });
  const latest: NarrationJobView | undefined = jobs.data?.[0];
  const pickedVoice = voices.data?.find((v) => v.id === voiceId);
  const running = latest?.status === 'running';

  const scenes = document.scenario.scenes;
  const spoken = scenes.filter((s) => s.narration.trim());
  const voiceRef = engine && voiceId ? `${engine.id}:${voiceId}` : null;
  const ready = !!voiceRef && !engine?.problem && !running;

  const cost = useMemo(() => {
    const price = engine?.pricePerMillionChars;
    if (price == null) return null;
    const chars = spoken.reduce((sum, s) => sum + s.narration.length, 0);
    return formatCost((chars * price) / 1_000_000);
  }, [engine, spoken]);

  async function speak(sceneIds: string[]): Promise<void> {
    if (!voiceRef) return;
    try {
      await studioAudioClient().speak({ videoId, sceneIds, voiceRef });
    } catch (error) {
      toast.error(errorMessage(error));
    }
    void queryClient.invalidateQueries({ queryKey: studioKeys.narrationJobs(videoId) });
  }

  async function caption(scene: Scene): Promise<void> {
    setCaptioning(scene.id);
    try {
      await adopt(await studioAudioClient().captionScene(videoId, scene.id));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCaptioning(null);
    }
  }

  function voiceLabel(ref: string | null): string {
    if (!ref) return 'No voice';
    if (ref === RECORDED_VOICE) return 'Your recording';
    const parsed = parseVoiceRef(ref);
    if (!parsed) return ref;
    const owner = engines.data?.find((e) => e.id === parsed.engine)?.label ?? parsed.engine;
    const name =
      parsed.engine === engineId
        ? (voices.data?.find((v) => v.id === parsed.voice)?.label ?? parsed.voice)
        : parsed.voice;
    return `${owner}, ${name}`;
  }

  const duck = document.renderSettings.audio.duck !== false;

  if (engines.isError)
    return (
      <LoadFailure
        message="Studio could not list the voice engines."
        retry={() => void engines.refetch()}
      />
    );

  return (
    <section aria-label="Voice" className={cn(GLASS_CARD, 'space-y-4 p-4')}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor={`${id}-engine`} className="text-xs font-medium text-muted-foreground">
            Engine
          </label>
          {engines.data ? (
            <Combobox
              id={`${id}-engine`}
              ariaLabel="Voice engine"
              className="w-48"
              searchable={false}
              value={engineId ?? ''}
              onChange={(value) => setEngineId(value as VoiceEngineView['id'])}
              options={engines.data.map((e) => ({
                value: e.id,
                label: `${e.label}${e.local ? ' (on this computer)' : ''}${e.problem ? ' (not set up)' : ''}`,
              }))}
            />
          ) : (
            <Skeleton className="h-8 w-48" />
          )}
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-voice`} className="text-xs font-medium text-muted-foreground">
            Voice
          </label>
          {voices.isLoading ? (
            <Skeleton className="h-8 w-56" />
          ) : (
            <Combobox
              id={`${id}-voice`}
              ariaLabel="Voice"
              className="w-56"
              disabled={!voices.data?.length}
              value={voiceId}
              onChange={setVoiceId}
              placeholder={engine?.problem ? 'Set up the engine first' : 'No voices'}
              options={(voices.data ?? []).map((v) => ({
                value: v.id,
                label: `${v.locale ? `${v.label} (${v.locale})` : v.label}${v.nonCommercial ? ', non-commercial' : ''}`,
                keywords: [v.id],
              }))}
            />
          )}
        </div>
        <Button
          disabled={!ready || spoken.length === 0}
          onClick={() => void speak(spoken.map((s) => s.id))}
        >
          <Play /> Speak every scene
        </Button>
        <Button variant="soft" onClick={() => setProfilesOpen(true)}>
          <Microphone /> Voices
        </Button>
        {cost && spoken.length > 0 && (
          <span className="pb-2 text-xs text-muted-foreground">
            {engine?.label} lists this at {cost}.
          </span>
        )}
      </div>

      {engine?.problem && (
        <Notice
          tone="warning"
          size="sm"
          action={
            engine.locked ? (
              <Button size="sm" variant="soft" onClick={() => setUnlocking(true)}>
                <Lock /> Unlock
              </Button>
            ) : engine.local && engine.problem.startsWith('Install') ? (
              <Button size="sm" variant="soft" onClick={onOpenDevSetup}>
                Open Dev Setup
              </Button>
            ) : engine.clones ? (
              <Button size="sm" variant="soft" onClick={() => setProfilesOpen(true)}>
                Voices
              </Button>
            ) : undefined
          }
        >
          {engine.problem}
        </Notice>
      )}
      {(engine?.nonCommercial || pickedVoice?.nonCommercial) && (
        <Notice tone="warning" size="sm">
          {engine?.nonCommercial
            ? `Everything ${engine.label} speaks is for non-commercial use only (its model is ${pickedVoice?.license ?? 'CC BY-NC 4.0'}).`
            : `${pickedVoice?.label} is for non-commercial use only (${pickedVoice?.license}).`}
        </Notice>
      )}
      {engine?.retiresOn && (
        <Notice tone="neutral" size="sm">
          {engine.label} retires this voice model on {engine.retiresOn}.
        </Notice>
      )}

      {latest && (running || latest.status === 'failed') && (
        <div
          role="status"
          aria-label="Narration progress"
          className="flex items-center gap-3 rounded-md bg-foreground/[0.04] px-3 py-2 text-sm"
        >
          {running ? (
            <>
              <Spinner />
              <span className="flex-1">
                Speaking
                {latest.sceneId
                  ? ` scene ${scenes.findIndex((s) => s.id === latest.sceneId) + 1}`
                  : ''}
                : {latest.done} of {latest.total} pieces
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void studioAudioClient()
                    .cancel(videoId, latest.id)
                    .catch((error: unknown) => toast.error(errorMessage(error)))
                }
              >
                Stop
              </Button>
            </>
          ) : (
            <span className="flex-1 text-destructive">
              Narration stopped: {latest.error}. Speaking again redoes only what is missing.
            </span>
          )}
        </div>
      )}

      <label className="flex items-start justify-between gap-4" htmlFor={`${id}-duck`}>
        <span>
          <span className="block text-sm font-medium">Lower the music while someone speaks</span>
          <span className="block text-xs text-muted-foreground">
            Music on the Music track drops by about 10 dB under the voice, in the render.
          </span>
        </span>
        <Switch
          id={`${id}-duck`}
          checked={duck}
          onCheckedChange={(checked) =>
            void apply(
              [
                {
                  op: 'render.set',
                  patch: { audio: { ...document.renderSettings.audio, duck: checked } },
                },
              ],
              checked ? 'Music lowered under the voice' : 'Music kept at its level',
            )
          }
        />
      </label>

      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Scenes</h3>
        {scenes.length === 0 ? (
          <EmptyState
            icon={Microphone}
            size="sm"
            title="No scenes yet"
            description="Write the scenario first, then give each scene its voice."
          />
        ) : (
          <ol className="space-y-1.5">
            {scenes.map((scene, index) => {
              const text = scene.narration.trim();
              const rtl = persianTextProps(text);
              return (
                <li
                  key={scene.id}
                  aria-label={`Scene ${index + 1}`}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-foreground/[0.03]"
                >
                  <span className="w-6 text-right text-sm tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <p
                    className={cn('line-clamp-2 min-w-0 flex-1 text-sm', rtl.className)}
                    dir={rtl.dir ?? 'auto'}
                  >
                    {text || <span className="text-muted-foreground">No narration</span>}
                  </p>
                  <Chip tone={scene.voiceRef ? 'success' : 'neutral'} dot>
                    {voiceLabel(scene.voiceRef)}
                  </Chip>
                  <SimpleTooltip label={`Speak scene ${index + 1} with the voice above`}>
                    <span className="inline-flex">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Speak scene ${index + 1}`}
                        disabled={!ready || !text}
                        onClick={() => void speak([scene.id])}
                      >
                        <Play />
                      </Button>
                    </span>
                  </SimpleTooltip>
                  <SimpleTooltip label={`Record scene ${index + 1} in your own voice`}>
                    <span className="inline-flex">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Record scene ${index + 1}`}
                        disabled={!text || running}
                        onClick={() => setRecordTarget({ scene, index })}
                      >
                        <Microphone />
                      </Button>
                    </span>
                  </SimpleTooltip>
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={!text || captioning !== null}
                    onClick={() => void caption(scene)}
                  >
                    {captioning === scene.id && <Spinner />} Caption
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <VoiceProfilesDialog
        open={profilesOpen}
        onOpenChange={setProfilesOpen}
        lang={document.language}
      />
      <RecordDialog
        videoId={videoId}
        target={recordTarget}
        onOpenChange={(open) => !open && setRecordTarget(null)}
        onPlaced={(result) => void adopt(result)}
      />
      <VaultUnlockDialog
        open={unlocking}
        onOpenChange={setUnlocking}
        mode="unlock"
        onUnlocked={() => {
          setUnlocking(false);
          void queryClient.invalidateQueries({ queryKey: studioKeys.voiceEngines });
        }}
      />
    </section>
  );
}
