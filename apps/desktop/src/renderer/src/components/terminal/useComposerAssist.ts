import {
  type AgentInstructionPurpose,
  type AgentInstructionTarget,
  buildAgentInstructionRequest,
} from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { promptProviderModel } from '@/lib/promptProvider';
import { queryKeys } from '@/lib/queryKeys';

/**
 * What "Write it for me" turns the note into: an instruction for an AI agent, or, for a box that
 * is not an agent task (Studio's video brief), whatever request the caller builds.
 */
export type ComposerRewrite =
  | {
      purpose: AgentInstructionPurpose;
      target: AgentInstructionTarget;
      /** The AI's question, when the text answers one. */
      question?: string;
      buildRequest?: undefined;
    }
  | {
      buildRequest: (note: string) => string;
      purpose?: undefined;
      target?: undefined;
      question?: undefined;
    };

export type ComposerAssistOptions = {
  value: string;
  onChange: (value: string) => void;
} & ComposerRewrite;

function rewriteRequest(rewrite: ComposerRewrite, text: string): string {
  if (rewrite.buildRequest) return rewrite.buildRequest(text);
  const { purpose, target, question } = rewrite;
  return buildAgentInstructionRequest({ text, purpose, target, question });
}

export type ComposerAssistJob = 'translate' | 'rewrite';

interface RunningJob {
  kind: ComposerAssistJob;
  requestId: string;
}

/**
 * Translate and "Write it for me" for an AI task box. Each replaces the text, and Undo brings back
 * what was typed until the user edits the result. Cancel stops the request in main as well, and a
 * result that lands after it is dropped.
 */
export function useComposerAssist(options: ComposerAssistOptions) {
  const { value, onChange } = options;
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
    meta: { silentLoading: true },
  });
  const [busy, setBusy] = useState<ComposerAssistJob | null>(null);
  const [undoState, setUndoState] = useState<{ before: string; after: string } | null>(null);
  const jobRef = useRef<RunningJob | null>(null);

  // Nothing comes back to a box that is gone, so main need not keep working on it.
  useEffect(() => () => void stop(), []);

  function begin(kind: ComposerAssistJob): RunningJob | null {
    if (jobRef.current || !value.trim()) return null;
    const job = { kind, requestId: crypto.randomUUID() };
    jobRef.current = job;
    setBusy(kind);
    return job;
  }

  function finish(job: RunningJob): boolean {
    if (jobRef.current !== job) return false;
    jobRef.current = null;
    setBusy(null);
    return true;
  }

  function replace(before: string, after: string): void {
    setUndoState({ before, after });
    onChange(after);
  }

  async function translate(): Promise<void> {
    const job = begin('translate');
    if (!job) return;
    const before = value;
    try {
      const translated = await window.runova.translate.text({
        text: before,
        targetLang: 'en',
        requestId: job.requestId,
      });
      if (finish(job)) replace(before, translated.trim());
    } catch {
      if (finish(job)) {
        toast.error('Translation failed. Check your internet connection and try again.');
      }
    }
  }

  async function rewrite(): Promise<void> {
    const job = begin('rewrite');
    if (!job) return;
    const before = value;
    try {
      const settings = settingsQuery.data ?? (await window.runova.settings.get());
      const { provider, model } = promptProviderModel(settings);
      if (!model.trim()) {
        if (finish(job)) toast.error(`Set a ${provider} model in Settings first.`);
        return;
      }
      const result = await window.runova.ai.ask({
        provider,
        model,
        prompt: rewriteRequest(options, before),
        requestId: job.requestId,
      });
      if (!finish(job) || result.cancelled) return;
      if (!result.ok) {
        toast.error(result.error || 'The AI could not write it.');
        return;
      }
      replace(before, result.text.trim());
    } catch (error) {
      if (finish(job)) toast.error((error as Error).message || 'The AI could not write it.');
    }
  }

  function stop(): boolean {
    const job = jobRef.current;
    if (!job) return false;
    jobRef.current = null;
    setBusy(null);
    void (job.kind === 'translate'
      ? window.runova.translate.cancel(job.requestId)
      : window.runova.ai.cancel(job.requestId));
    return true;
  }

  // Once the user edits the result, Undo would throw their typing away, so it is gone.
  const canUndo = undoState !== null && undoState.after === value;

  function undo(): void {
    if (!canUndo || !undoState) return;
    onChange(undoState.before);
    setUndoState(null);
  }

  return { busy, translate, rewrite, cancel: stop, undo, canUndo };
}
