import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drives a scene page in a sandboxed iframe: asks it for a moment (`studio:seek`) and waits for
 * `studio:frame`. While a frame is still being drawn, newer requests wait and only the latest one
 * goes next, so a slow scene drops frames instead of falling further and further behind.
 */
export function useSceneSeek() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [slow, setSlow] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const pending = useRef(false);
  const queued = useRef<number | null>(null);
  const nextId = useRef(1);
  const sentAt = useRef(0);

  const send = useCallback((t: number) => {
    const target = frameRef.current?.contentWindow;
    if (!target) return;
    if (pending.current) {
      queued.current = t;
      return;
    }
    pending.current = true;
    sentAt.current = performance.now();
    target.postMessage({ type: 'studio:seek', t, id: nextId.current++ }, '*');
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; errors?: string[] } | null;
      if (data?.type !== 'studio:frame') return;
      pending.current = false;
      setSlow(performance.now() - sentAt.current > 120);
      if (Array.isArray(data.errors)) setErrors(data.errors.slice(0, 20));
      const next = queued.current;
      queued.current = null;
      if (next !== null) send(next);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [send]);

  /** A freshly loaded page has no frame in flight. */
  const loaded = useCallback(() => {
    pending.current = false;
  }, []);

  return { frameRef, send, loaded, slow, errors };
}
