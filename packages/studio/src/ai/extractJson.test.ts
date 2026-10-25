import { describe, expect, it } from 'vitest';
import { extractJson } from './extractJson.js';

describe('extractJson', () => {
  it('reads a bare JSON answer', () => {
    expect(extractJson('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('prefers the last fenced json block, which is the final answer after any drafts', () => {
    const text = 'Draft:\n```json\n{"a": 1}\n```\nFixed:\n```json\n{"a": 2}\n```\nDone.';
    expect(extractJson(text)).toEqual({ ok: true, value: { a: 2 } });
  });

  it('reads an unlabelled fence', () => {
    expect(extractJson('Here it is\n```\n{"a": [1, 2]}\n```')).toEqual({
      ok: true,
      value: { a: [1, 2] },
    });
  });

  it('falls back to the balanced object inside prose', () => {
    const text = 'Sure! Here is the scenario: {"title": "x", "nested": {"b": "}"}} Enjoy.';
    expect(extractJson(text)).toEqual({ ok: true, value: { title: 'x', nested: { b: '}' } } });
  });

  it('skips a broken fence and still finds a good object after it', () => {
    const text = '```json\n{"a": \n```\nThen: {"a": 3}';
    expect(extractJson(text)).toEqual({ ok: true, value: { a: 3 } });
  });

  it('keeps Persian text and escaped quotes intact', () => {
    const text = 'پاسخ: {"narration": "سلام \\"دنیا\\"", "x": "می‌خواهم"}';
    expect(extractJson(text)).toEqual({
      ok: true,
      value: { narration: 'سلام "دنیا"', x: 'می‌خواهم' },
    });
  });

  it('strips a byte order mark', () => {
    expect(extractJson('﻿{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('says why when there is no JSON at all', () => {
    expect(extractJson('I could not do that.')).toEqual({
      ok: false,
      reason: 'The answer has no JSON object in it.',
    });
  });

  it('says why when the JSON is cut off', () => {
    const result = extractJson('{"scenes": [{"title": "a"');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not valid JSON/);
  });

  it('refuses a top-level array, since every answer is an object', () => {
    expect(extractJson('[1, 2]').ok).toBe(false);
  });
});
