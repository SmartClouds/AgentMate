import { defaultGrammarSettings, type GrammarSettings } from '@runova/core';
import type { GrammarIssue } from '@shared/grammar';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { alignIssues, issueKey, type TextField } from '@/lib/grammar';
import { registerFieldGrammar, unregisterFieldGrammar } from '@/lib/grammarRegistry';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Long enough that a normal typing run doesn't spend the public API's request
 * budget, short enough that a pause to think brings the underlines back.
 */
const DEBOUNCE_MS = 1400;

export interface UseGrammarCheckOptions {
  /** The field's current value, as the host component holds it. */
  value: string;
  /** The field itself. Underlines and right-click lookups both need the element. */
  field: TextField | null;
  /** Off for fields holding code, paths, or CLI arguments. */
  enabled?: boolean;
}

export interface GrammarCheckState {
  /** Issues that still line up with the current value. */
  issues: GrammarIssue[];
  checking: boolean;
  /** Why the last check failed, ready to show. Null once one succeeds. */
  error: string | null;
  /** Language LanguageTool reported for the last check, for the panel's footer. */
  language: string;
  /** Character count the check stopped at, when the text was longer than the endpoint allows. */
  truncatedAt: number | null;
  /** Whether checking is on at all, so a host can hide its writing button. */
  active: boolean;
  settings: GrammarSettings;
  /** Runs a check now and returns what it found. */
  recheck: () => Promise<GrammarIssue[]>;
  /** Hides one issue until the text changes. */
  dismiss: (issue: GrammarIssue) => void;
}

/**
 * Keeps one text field's LanguageTool issues up to date and publishes them for
 * the app-wide writing menu. Live checking follows the user's settings; a host
 * can always ask for a check itself through `recheck`.
 */
export function useGrammarCheck({
  value,
  field,
  enabled = true,
}: UseGrammarCheckOptions): GrammarCheckState {
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  const settings = settingsQuery.data?.grammar ?? defaultGrammarSettings();

  const [issues, setIssues] = useState<GrammarIssue[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState('');
  const [truncatedAt, setTruncatedAt] = useState<number | null>(null);
  const dismissedRef = useRef(new Set<string>());
  /** Guards against a slow check overwriting a newer one's result. */
  const requestIdRef = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;

  const active = enabled && settings.enabled;

  const runCheck = useCallback(async (): Promise<GrammarIssue[]> => {
    const text = valueRef.current;
    const requestId = ++requestIdRef.current;
    if (!text.trim()) {
      setIssues([]);
      setChecking(false);
      return [];
    }
    setChecking(true);
    try {
      const result = await window.runova.grammar.check({ text });
      if (requestId !== requestIdRef.current) return [];
      const found = result.issues.filter((issue) => !dismissedRef.current.has(issueKey(issue)));
      setIssues(found);
      setLanguage(result.language);
      setTruncatedAt(result.truncatedAt);
      setError(null);
      return found;
    } catch (cause) {
      if (requestId !== requestIdRef.current) return [];
      setError(cause instanceof Error ? cause.message : String(cause));
      return [];
    } finally {
      if (requestId === requestIdRef.current) setChecking(false);
    }
  }, []);

  // Editing invalidates dismissals: the same rule firing on rewritten text is
  // news again.
  const lastCheckedRef = useRef('');
  useEffect(() => {
    if (value !== lastCheckedRef.current) dismissedRef.current.clear();
  }, [value]);

  useEffect(() => {
    if (!active || !settings.liveCheck) {
      setIssues([]);
      return;
    }
    if (!value.trim()) {
      setIssues([]);
      return;
    }
    if (value === lastCheckedRef.current) return;
    const timer = setTimeout(() => {
      lastCheckedRef.current = value;
      void runCheck();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, active, settings.liveCheck, runCheck]);

  // A settings change (language, picky, online/local) makes the current issues
  // the wrong ones, so the next pass starts from scratch.
  useEffect(() => {
    lastCheckedRef.current = '';
    setError(null);
  }, [
    settings.language,
    settings.motherTongue,
    settings.picky,
    settings.source,
    settings.ignoredRules,
  ]);

  const dismiss = useCallback((issue: GrammarIssue): void => {
    dismissedRef.current.add(issueKey(issue));
    setIssues((current) => current.filter((entry) => issueKey(entry) !== issueKey(issue)));
  }, []);

  const aligned = useMemo(
    () => (active ? alignIssues(issues, value) : []),
    [active, issues, value],
  );

  // The writing menu reads this on right-click; it has no other way to know what
  // was already found in the field the user clicked.
  useEffect(() => {
    if (!field || !active) return;
    registerFieldGrammar(field, {
      issues: aligned,
      value,
      dismiss,
      recheck: async () => {
        lastCheckedRef.current = valueRef.current;
        return runCheck();
      },
    });
    return () => unregisterFieldGrammar(field);
  }, [field, active, aligned, value, dismiss, runCheck]);

  return {
    issues: aligned,
    checking,
    error,
    language,
    truncatedAt,
    active,
    settings,
    recheck: useCallback(async () => {
      lastCheckedRef.current = valueRef.current;
      return runCheck();
    }, [runCheck]),
    dismiss,
  };
}
