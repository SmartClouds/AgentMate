import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Records narration from the microphone: a MediaRecorder for the sound, and an analyser for the
 * level meter, so the user sees they are being heard before they say a whole scene.
 */

export type RecorderState = 'idle' | 'starting' | 'recording' | 'done';

export interface NarrationRecorder {
  supported: boolean;
  state: RecorderState;
  /** The loudness right now, from 0 to 1, while recording. */
  level: number;
  elapsedSeconds: number;
  /** The finished take, with its type, after `stop`. */
  take: { blob: Blob; url: string } | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  /** Throws the take away and goes back to idle. */
  reset: () => void;
}

const PREFERRED_TYPE = 'audio/webm;codecs=opus';

export function useNarrationRecorder(): NarrationRecorder {
  const [state, setState] = useState<RecorderState>('idle');
  const [level, setLevel] = useState(0);
  const [elapsedSeconds, setElapsed] = useState(0);
  const [take, setTake] = useState<NarrationRecorder['take']>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    context: AudioContext;
    timer: number;
    frame: number;
  } | null>(null);

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  const release = useCallback(() => {
    const current = live.current;
    if (!current) return;
    live.current = null;
    window.clearInterval(current.timer);
    cancelAnimationFrame(current.frame);
    for (const track of current.stream.getTracks()) track.stop();
    void current.context.close().catch(() => undefined);
    setLevel(0);
  }, []);

  useEffect(() => release, [release]);
  useEffect(
    () => () => {
      if (take) URL.revokeObjectURL(take.url);
    },
    [take],
  );

  const start = useCallback(async () => {
    if (!supported || live.current) return;
    setError(null);
    setTake(null);
    setState('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      setState('idle');
      setError('Studio could not use the microphone. Check that it is plugged in and allowed.');
      return;
    }
    const type = MediaRecorder.isTypeSupported?.(PREFERRED_TYPE) ? PREFERRED_TYPE : undefined;
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      setTake({ blob, url: URL.createObjectURL(blob) });
      setState('done');
    };
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const begun = Date.now();
    const current = {
      recorder,
      stream,
      context,
      timer: window.setInterval(() => setElapsed(Math.floor((Date.now() - begun) / 1000)), 250),
      frame: 0,
    };
    const meter = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      // Speech sits around 0.05 to 0.2 RMS; scaled so a normal voice fills most of the bar.
      setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 5));
      current.frame = requestAnimationFrame(meter);
    };
    live.current = current;
    setElapsed(0);
    recorder.start(250);
    current.frame = requestAnimationFrame(meter);
    setState('recording');
  }, [supported]);

  const stop = useCallback(() => {
    const current = live.current;
    if (!current) return;
    if (current.recorder.state !== 'inactive') current.recorder.stop();
    release();
  }, [release]);

  const reset = useCallback(() => {
    release();
    setTake(null);
    setElapsed(0);
    setState('idle');
  }, [release]);

  return { supported, state, level, elapsedSeconds, take, error, start, stop, reset };
}
