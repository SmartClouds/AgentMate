import type { GrammarIssueKind } from '@runova/core';

/** One thing LanguageTool flagged, flattened from its `matches` entry. */
export interface GrammarIssue {
  /** Start offset in the text that was checked. */
  offset: number;
  length: number;
  /**
   * The flagged text itself. The renderer compares it against the field's
   * current value before drawing or replacing anything, so an edit that landed
   * while the check was in flight can't shift a fix onto the wrong words.
   */
  text: string;
  /** Full explanation, e.g. "Possible agreement error". */
  message: string;
  /** LanguageTool's own short label, when it has one. Falls back to the kind. */
  shortMessage: string;
  kind: GrammarIssueKind;
  /** Rule id, e.g. "HE_VERB_AGR". Used for "stop flagging this". */
  ruleId: string;
  /** Human-readable category, e.g. "Grammar". */
  categoryName: string;
  /** Suggested replacements, best first, capped so the menu stays usable. */
  replacements: string[];
}

export interface GrammarCheckInput {
  text: string;
  /** Overrides the configured language for this one check; mainly for tests and mixed-language fields. */
  language?: string;
}

export interface GrammarCheckResult {
  issues: GrammarIssue[];
  /** Language LanguageTool actually used, e.g. "English (US)". Empty when it didn't say. */
  language: string;
  source: 'online' | 'local';
  /** Set when the text was cut to the endpoint's limit, so the UI can say the tail wasn't checked. */
  truncatedAt: number | null;
}

export type GrammarServerState = 'stopped' | 'starting' | 'running' | 'error';

/** Everything Settings and the Tools card need to describe the local install. */
export interface GrammarLocalStatus {
  /** Folder the user drops the LanguageTool zip into. */
  toolsDir: string;
  /** Folder of the detected distribution, or null when nothing usable is there. */
  installPath: string | null;
  /** Version read from the folder name, e.g. "6.6". Null when it can't be told. */
  version: string | null;
  /** First line of `java -version`, or null when Java isn't on PATH. */
  javaVersion: string | null;
  /** Major version read from that line (8, 11, 21…), or null when it couldn't be read. */
  javaMajor: number | null;
  serverState: GrammarServerState;
  port: number;
  /** Why the server stopped or refused to start. */
  error: string | null;
}
