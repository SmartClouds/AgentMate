/**
 * Pulls the JSON object out of an AI CLI's answer. Models are asked for JSON only, but they wrap it
 * in a fence, add a sentence before it, or print a draft and then a fixed copy. So this tries, in
 * order: fenced blocks (the last one first, since that is the final answer), then every balanced
 * `{...}` in the text. The first candidate that parses to an object wins.
 */

export type JsonExtraction =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string };

const FENCE = /```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/g;

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Every top-level `{...}` span, found by counting braces outside of strings. A brace that never
 * closes (a cut-off draft) would swallow everything after it, so the scan starts again just past it.
 */
function balancedObjects(text: string, from = 0): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) spans.push(text.slice(start, i + 1));
    }
  }
  if (depth > 0) spans.push(...balancedObjects(text, start + 1));
  return spans;
}

export function extractJson(answer: string): JsonExtraction {
  const text = answer.replace(/^﻿/, '').trim();
  const whole = parseObject(text);
  if (whole) return { ok: true, value: whole };

  const fenced = [...text.matchAll(FENCE)].map((m) => m[1] ?? '').reverse();
  for (const block of fenced) {
    const value = parseObject(block.trim());
    if (value) return { ok: true, value };
  }
  const spans = balancedObjects(text).reverse();
  for (const span of spans) {
    const value = parseObject(span);
    if (value) return { ok: true, value };
  }
  if (!text.includes('{')) return { ok: false, reason: 'The answer has no JSON object in it.' };
  return {
    ok: false,
    reason: 'The answer has a JSON object in it, but it is not valid JSON (it may be cut off).',
  };
}
