import { CONSENT_STATEMENT, type VoiceProfileView } from '@runova/studio';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { studioAudioClient } from '../client';
import { errorMessage, formatSeconds } from '../format';
import {
  Button,
  Checkbox,
  Chip,
  cn,
  confirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Microphone,
  Notice,
  persianTextProps,
  Skeleton,
  Spinner,
  StopCircle,
  Textarea,
  Trash2,
  toast,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { useNarrationRecorder } from './useNarrationRecorder';

export interface VoiceProfilesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The video's language, for the text to read and the speech recognition. */
  lang: string;
}

/** Something to read for a take: about eight seconds of ordinary speech. */
const READ_THIS: Record<string, string> = {
  fa: 'امروز می‌خواهم درباره‌ی پروژه‌ای صحبت کنم که مدتی است روی آن کار می‌کنیم. هدف ما ساده است: کارها را سریع‌تر و راحت‌تر انجام دهیم.',
  en: 'Today I want to talk about a project we have been working on for a while. Our goal is simple: to get things done faster and more easily.',
};

/**
 * Voice profiles: a few seconds of someone's voice that OmniVoice, or ElevenLabs once uploaded,
 * speaks narration with. A profile is only made after its maker confirms the voice is theirs or
 * that they may use it, and only goes to ElevenLabs after they agree to the upload.
 */
export function VoiceProfilesDialog({
  open,
  onOpenChange,
  lang,
}: VoiceProfilesDialogProps): React.JSX.Element {
  const id = useId();
  const queryClient = useQueryClient();
  const profiles = useQuery({
    queryKey: studioKeys.voiceProfiles,
    queryFn: () => studioAudioClient().profiles(),
    enabled: open,
  });
  const recorder = useNarrationRecorder();
  const [name, setName] = useState('');
  const [transcript, setTranscript] = useState('');
  const [seconds, setSeconds] = useState<number | null>(null);
  const [consent, setConsent] = useState(false);
  const [listening, setListening] = useState(false);
  const { reset } = recorder;
  const primary = lang.split('-')[0] ?? 'en';
  const script = READ_THIS[primary] ?? READ_THIS.en ?? '';

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: studioKeys.voiceProfiles });
    void queryClient.invalidateQueries({ queryKey: studioKeys.voiceEngines });
    void queryClient.invalidateQueries({ queryKey: ['studio', 'voices'] });
  };

  const clearTake = () => {
    reset();
    setTranscript('');
    setSeconds(null);
    setConsent(false);
  };

  // A closed dialog forgets its take, so the next one starts clean.
  useEffect(() => {
    if (open) return;
    reset();
    setTranscript('');
    setSeconds(null);
    setConsent(false);
    setName('');
  }, [open, reset]);

  // Once a take is in, speech recognition fills in what it says, which the person can correct.
  useEffect(() => {
    const take = recorder.take;
    if (!take) return;
    let stale = false;
    setListening(true);
    void (async () => {
      try {
        const heard = await studioAudioClient().transcribeTake({
          bytes: new Uint8Array(await take.blob.arrayBuffer()),
          mimeType: take.blob.type || 'audio/webm',
          lang: primary,
        });
        if (stale) return;
        setSeconds(heard.seconds);
        setTranscript(heard.text);
      } catch (error) {
        if (!stale) toast.error(errorMessage(error));
      } finally {
        if (!stale) setListening(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [recorder.take, primary]);

  const save = useMutation({
    mutationFn: async () => {
      const take = recorder.take;
      if (!take) throw new Error('Record a take first.');
      return studioAudioClient().createProfile({
        bytes: new Uint8Array(await take.blob.arrayBuffer()),
        mimeType: take.blob.type || 'audio/webm',
        name: name.trim(),
        lang: primary,
        transcript,
        consent: true,
      });
    },
    onSuccess: (profile) => {
      toast.success(`${profile.name} is ready to speak with.`);
      clearTake();
      setName('');
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  async function upload(profile: VoiceProfileView): Promise<void> {
    const ok = await confirmDialog({
      title: `Upload ${profile.name} to ElevenLabs?`,
      description:
        'The recording goes to your ElevenLabs account, where it becomes a voice you can pick for narration. ElevenLabs keeps it until you remove the profile here or the voice there.',
      confirmLabel: 'Upload',
    });
    if (!ok) return;
    try {
      await studioAudioClient().cloneProfile(profile.id);
      toast.success(`${profile.name} is now in your ElevenLabs voices.`);
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function remove(profile: VoiceProfileView): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete ${profile.name}?`,
      description: profile.elevenlabsVoiceId
        ? 'The recording is deleted here, and the voice made from it is removed from your ElevenLabs account. Narration already spoken with it stays.'
        : 'The recording is deleted. Narration already spoken with it stays.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await studioAudioClient().removeProfile(profile.id);
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const recording = recorder.state === 'recording';
  const canSave = !!recorder.take && seconds !== null && consent && name.trim() && !listening;
  const scriptProps = persianTextProps(script);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Voices</DialogTitle>
          <DialogDescription>
            Your own voice, or one you may use, for OmniVoice to clone on this computer or for
            ElevenLabs once you upload it.
          </DialogDescription>
        </DialogHeader>

        <section aria-label="Voice profiles" className="space-y-1.5">
          {profiles.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (profiles.data ?? []).length === 0 ? (
            <EmptyState
              icon={Microphone}
              size="sm"
              title="No voices yet"
              description="Record a few seconds below to make the first one."
            />
          ) : (
            <ul className="space-y-1">
              {(profiles.data ?? []).map((profile) => (
                <li
                  key={profile.id}
                  aria-label={profile.name}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-foreground/[0.03]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" dir="auto">
                      {profile.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {formatSeconds(profile.seconds)} recorded
                    </span>
                  </span>
                  {profile.elevenlabsVoiceId ? (
                    <Chip tone="success" dot>
                      In ElevenLabs
                    </Chip>
                  ) : (
                    <Button size="sm" variant="soft" onClick={() => void upload(profile)}>
                      Upload to ElevenLabs
                    </Button>
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${profile.name}`}
                    onClick={() => void remove(profile)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="New voice" className="space-y-3 border-t pt-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`}>New voice</Label>
            <Input
              id={`${id}-name`}
              value={name}
              dir="auto"
              maxLength={80}
              placeholder="Name it, such as My voice"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <p
            aria-label="Text to read"
            className={cn(
              'rounded-md bg-muted/40 p-3 text-base leading-relaxed',
              scriptProps.className,
            )}
            dir={scriptProps.dir ?? 'auto'}
          >
            {script}
          </p>
          <div className="flex items-center gap-3">
            {recording ? (
              <Button onClick={recorder.stop}>
                <StopCircle /> Stop
              </Button>
            ) : (
              <Button
                variant={recorder.take ? 'ghost' : 'default'}
                disabled={!recorder.supported || recorder.state === 'starting' || save.isPending}
                onClick={() => {
                  clearTake();
                  void recorder.start();
                }}
              >
                <Microphone /> {recorder.take ? 'Record again' : 'Record'}
              </Button>
            )}
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
            <span className="w-16 text-right text-sm tabular-nums text-muted-foreground">
              {recording
                ? formatSeconds(recorder.elapsedSeconds)
                : seconds !== null
                  ? formatSeconds(seconds)
                  : ''}
            </span>
          </div>
          {recorder.error && (
            <Notice tone="destructive" size="sm">
              {recorder.error}
            </Notice>
          )}
          {recorder.take && (
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-said`}>What the take says</Label>
              {listening ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner /> Listening to the take
                </p>
              ) : (
                <Textarea
                  id={`${id}-said`}
                  value={transcript}
                  dir="auto"
                  rows={2}
                  className={persianTextProps(transcript).className}
                  onChange={(event) => setTranscript(event.target.value)}
                />
              )}
            </div>
          )}
          <label className="flex items-start gap-2 text-sm" htmlFor={`${id}-consent`}>
            <Checkbox
              id={`${id}-consent`}
              checked={consent}
              onCheckedChange={(checked) => setConsent(checked === true)}
              className="mt-0.5"
            />
            <span>{CONSENT_STATEMENT}</span>
          </label>
          <div className="flex justify-end">
            <Button disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Spinner />} Save voice
            </Button>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
