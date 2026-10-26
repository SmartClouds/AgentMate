import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceStatus = 'idle' | 'requesting' | 'recording' | 'transcribing';

// Whisper is trained on 16 kHz mono audio; the microphone almost always
// captures at 44.1/48 kHz, so we resample down before handing samples to the
// main process. Doing the conversion here (Web Audio) keeps ffmpeg and every
// other audio tool out of the packaged app.
const WHISPER_SAMPLE_RATE = 16000;

// Whisper makes up words for silence ("Thank you.", "Bye."), so a clip this short, or this quiet
// all the way through, is never sent. A peak under 0.01 is below -40 dBFS, quieter than speech
// reaches even from across a room with the browser's automatic gain on.
const MIN_SPEECH_SECONDS = 0.4;
const MIN_SPEECH_PEAK = 0.01;
export const NOTHING_HEARD_MESSAGE = "Didn't catch anything. Try again a little closer to the mic.";

// The level meter maps this range of loudness onto 0 to 1. Room noise sits under the floor and
// ordinary speech lands around the middle, so the bars move for a voice and stay low for a fan.
const METER_FFT_SIZE = 512;
const METER_FLOOR_DB = -60;
const METER_CEILING_DB = -10;

interface UseVoiceInputOptions {
  /** Whisper language code ("en", "fa", …) or "auto". */
  language: string;
  /** Called with the transcribed text once recording stops and transcription finishes. */
  onText: (text: string) => void;
}

interface UseVoiceInput {
  status: VoiceStatus;
  /** 0–100 while the model downloads on first use, otherwise null. */
  downloadPercent: number | null;
  error: string | null;
  /** Whole seconds since recording started, 0 when not recording. */
  elapsedSeconds: number;
  /**
   * How loud the microphone is right now, 0 to 1, or 0 when nothing is recording. Not state:
   * read it from an animation frame, so a meter never re-renders the component that owns the mic.
   */
  getLevel: () => number;
  /** Start recording if idle, stop-and-transcribe if recording. */
  toggle: () => void;
  /** Stop without transcribing, or drop a transcription that is still running. */
  cancel: () => void;
  supported: boolean;
}

/** True when the clip has something in it worth handing to Whisper. */
export function hasSpeech(samples: Float32Array): boolean {
  if (samples.length < MIN_SPEECH_SECONDS * WHISPER_SAMPLE_RATE) return false;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) >= MIN_SPEECH_PEAK) return true;
  }
  return false;
}

/** How loud a slice of microphone audio is on a level meter's scale: 0 for quiet, 1 for loud. */
export function levelFromSamples(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumOfSquares = 0;
  for (let i = 0; i < samples.length; i++) sumOfSquares += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sumOfSquares / samples.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)));
}

async function blobToWhisperSamples(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();

  // Decode at whatever rate the browser recorded, then resample to 16 kHz mono
  // through an OfflineAudioContext.
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    void decodeCtx.close();
  }

  const frameCount = Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE || 0);
  if (frameCount === 0) return new Float32Array(0);

  const offline = new OfflineAudioContext(1, frameCount, WHISPER_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  // Channel 0 is the mono mixdown OfflineAudioContext produced for us.
  return rendered.getChannelData(0);
}

export function useVoiceInput({ language, onText }: UseVoiceInputOptions): UseVoiceInput {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const meterRef = useRef<{
    context: AudioContext;
    analyser: AnalyserNode;
    samples: Float32Array<ArrayBuffer>;
  } | null>(null);
  // Bumped by cancel(). A recording or transcription started under an older number is dropped
  // when it finishes, so it can neither fill the box nor reset a newer recording's state.
  const generationRef = useRef(0);
  // The transcription main is working on for this mic, so cancel() can stop it there too.
  const requestIdRef = useRef<string | null>(null);

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  // Surface first-run model-download progress pushed from the main process.
  useEffect(() => {
    const unsubscribe = window.runova.speech.onModelProgress((progress) => {
      setDownloadPercent(progress.percent);
    });
    return unsubscribe;
  }, []);

  // The analyser only listens: it is never connected to the speakers, so nothing plays back.
  const openMeter = useCallback((stream: MediaStream) => {
    let context: AudioContext | null = null;
    try {
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = METER_FFT_SIZE;
      context.createMediaStreamSource(stream).connect(analyser);
      meterRef.current = { context, analyser, samples: new Float32Array(analyser.fftSize) };
    } catch {
      // The level bars are a nicety. Recording carries on without them.
      void context?.close().catch(() => undefined);
    }
  }, []);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const meter = meterRef.current;
    meterRef.current = null;
    void meter?.context.close().catch(() => undefined);
  }, []);

  const getLevel = useCallback((): number => {
    const meter = meterRef.current;
    if (!meter) return 0;
    meter.analyser.getFloatTimeDomainData(meter.samples);
    return levelFromSamples(meter.samples);
  }, []);

  const transcribe = useCallback(
    async (blob: Blob) => {
      const generation = generationRef.current;
      const current = () => generation === generationRef.current;
      setStatus('transcribing');
      try {
        const samples = await blobToWhisperSamples(blob);
        if (samples.length === 0) return;
        if (!hasSpeech(samples)) {
          if (current()) setError(NOTHING_HEARD_MESSAGE);
          return;
        }
        const requestId = crypto.randomUUID();
        requestIdRef.current = requestId;
        const result = await window.runova.speech.transcribe({ samples, language, requestId });
        if (requestIdRef.current === requestId) requestIdRef.current = null;
        if (!current()) return;
        if (result.ok) {
          if (result.text) onText(result.text);
        } else {
          setError(result.error || 'Transcription failed.');
        }
      } catch (err) {
        if (current()) setError((err as Error).message || 'Could not process the recording.');
      } finally {
        if (current()) {
          setDownloadPercent(null);
          setStatus('idle');
        }
      }
    },
    [language, onText],
  );

  const start = useCallback(async () => {
    setError(null);
    // Progress is broadcast to every mic on the page, so a download another one started can
    // leave a finished percentage here. A fresh recording starts without it.
    setDownloadPercent(null);
    setStatus('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      const generation = generationRef.current;
      recorder.onstop = () => {
        stopTracks();
        if (generation !== generationRef.current) return;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        void transcribe(blob);
      };
      recorder.start();
      recorderRef.current = recorder;
      openMeter(stream);
      setStatus('recording');
    } catch (err) {
      stopTracks();
      setStatus('idle');
      const name = (err as Error).name;
      setError(
        name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it to use voice input.'
          : name === 'NotFoundError'
            ? 'No microphone was found.'
            : (err as Error).message || 'Could not start recording.',
      );
    }
  }, [openMeter, stopTracks, transcribe]);

  const stop = useCallback(() => {
    // The recorder's onstop handler kicks off transcription.
    recorderRef.current?.stop();
    recorderRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    if (status === 'recording') stop();
    else if (status === 'idle') void start();
  }, [status, start, stop]);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    // A long transcription keeps the CPU busy and holds up the next one, so it is stopped, not
    // just ignored.
    const requestId = requestIdRef.current;
    requestIdRef.current = null;
    if (requestId) void window.runova.speech.cancel(requestId).catch(() => undefined);
    recorderRef.current?.stop();
    recorderRef.current = null;
    stopTracks();
    setDownloadPercent(null);
    setStatus('idle');
  }, [stopTracks]);

  useEffect(() => {
    if (status !== 'recording') {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, [status]);

  // Release the mic if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      recorderRef.current?.stop();
      stopTracks();
    };
  }, [stopTracks]);

  return { status, downloadPercent, error, elapsedSeconds, getLevel, toggle, cancel, supported };
}
