import type { TextSearchOptions, TextSearchSummary } from '@shared/apiTypes';
import { startTransition, useEffect, useRef, useState } from 'react';
import { emptyTextResults, mergeBatch, type TextResults } from '@/lib/workspaceSearch/textResults';

export interface TextSearchPlan {
  /** Wait this long after the last keystroke before searching. */
  delayMs: number;
  /** Shorter queries match nearly every line and are not worth a search. */
  minChars: number;
  maxMatches?: number;
}

interface TextSearchState {
  /** The query and options the results are for. */
  key: string | null;
  results: TextResults;
  /** What the last search showed, kept on screen until the new one has something. */
  previous: TextResults | null;
  running: boolean;
  summary: TextSearchSummary | null;
}

const IDLE: TextSearchState = {
  key: null,
  results: emptyTextResults(),
  previous: null,
  running: false,
  summary: null,
};

/**
 * Runs ripgrep for the typed text once typing settles, and gathers the matches as they stream
 * in. A new query replaces the running search (the main process stops the old one), and
 * closing the dialog stops it too.
 */
export function useTextSearch(
  projectId: string,
  query: string,
  options: TextSearchOptions,
  plan: TextSearchPlan | null,
) {
  const [state, setState] = useState<TextSearchState>(IDLE);
  const currentId = useRef<string | null>(null);

  useEffect(
    () =>
      window.runova.workspaceSearch.onTextResults((batch) => {
        if (batch.requestId !== currentId.current) return;
        // Batches can arrive faster than a frame; typing takes priority over drawing them.
        startTransition(() => {
          setState((current) => ({ ...current, results: mergeBatch(current.results, batch) }));
        });
      }),
    [],
  );

  const { matchCase, wholeWord, regex } = options;
  const active = plan !== null && query.length >= plan.minChars;
  const delayMs = plan?.delayMs ?? 0;
  const maxMatches = plan?.maxMatches;
  const key = `${projectId}\n${query}\n${matchCase}${wholeWord}${regex}\n${maxMatches ?? ''}`;

  useEffect(() => {
    if (!active) {
      const running = currentId.current;
      currentId.current = null;
      if (running) void window.runova.workspaceSearch.cancel(running);
      setState((current) => (current === IDLE ? current : IDLE));
      return;
    }
    const timer = setTimeout(() => {
      const requestId = crypto.randomUUID();
      currentId.current = requestId;
      setState((current) => ({
        key,
        results: emptyTextResults(requestId),
        previous: current.results.files.length > 0 ? current.results : current.previous,
        running: true,
        summary: null,
      }));
      window.runova.workspaceSearch
        .text(projectId, requestId, { query, matchCase, wholeWord, regex, maxMatches })
        .then(
          (summary) => summary,
          (error: unknown): TextSearchSummary => ({
            requestId,
            matches: 0,
            files: 0,
            truncated: false,
            cancelled: false,
            error: error instanceof Error ? error.message : 'The search failed.',
            elapsedMs: 0,
          }),
        )
        .then((summary) => {
          if (currentId.current !== requestId) return;
          setState((current) => ({ ...current, previous: null, running: false, summary }));
        });
    }, delayMs);
    return () => clearTimeout(timer);
  }, [key, projectId, query, matchCase, wholeWord, regex, active, delayMs, maxMatches]);

  useEffect(
    () => () => {
      if (currentId.current) void window.runova.workspaceSearch.cancel(currentId.current);
      currentId.current = null;
    },
    [],
  );

  const showingPrevious = state.results.files.length === 0 && state.running && state.previous;
  return {
    results: showingPrevious ? (state.previous as TextResults) : state.results,
    /** What is on screen belongs to an earlier query, so the list dims until it catches up. */
    stale: Boolean(showingPrevious) || (active && state.key !== key),
    /** Searching, or about to once typing settles. */
    running: state.running || (active && state.key !== key),
    summary: state.summary,
    active,
  };
}
