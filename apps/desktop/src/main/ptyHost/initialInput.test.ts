import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANONICAL_LINE_LIMIT, needsPrompt, sendInitialInput } from './initialInput';

const MARKER = '\x1b]7750;Runova:PromptReady:1\x07';
const TIMING = { settleMs: 100, fallbackMs: 10_000 };
const LONG = `claude '${'x'.repeat(CANONICAL_LINE_LIMIT)}'\r`;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('needsPrompt', () => {
  it('lets a short command through at once', () => {
    expect(needsPrompt('claude --version\r', 'darwin')).toBe(false);
  });

  it('holds a line longer than a Mac terminal takes before the shell is up', () => {
    expect(needsPrompt(LONG, 'darwin')).toBe(true);
    expect(needsPrompt(LONG, 'linux')).toBe(true);
  });

  it('counts bytes, not characters', () => {
    // 600 Persian letters are 1200 bytes in UTF-8.
    expect(needsPrompt(`echo ${'س'.repeat(600)}\r`, 'darwin')).toBe(true);
  });

  it('measures each line on its own', () => {
    const lines = Array.from({ length: 4 }, () => 'y'.repeat(CANONICAL_LINE_LIMIT - 10)).join('\r');
    expect(needsPrompt(lines, 'darwin')).toBe(false);
  });

  it('never holds input on Windows, where ConPTY has no such limit', () => {
    expect(needsPrompt(LONG, 'win32')).toBe(false);
  });
});

describe('sendInitialInput', () => {
  it('writes a short command straight away', () => {
    const write = vi.fn();
    sendInitialInput('ls\r', write, 'darwin', TIMING);
    expect(write).toHaveBeenCalledWith('ls\r');
  });

  it('writes a long command just after the first prompt', () => {
    const write = vi.fn();
    const input = sendInitialInput(LONG, write, 'darwin', TIMING);

    input.onOutput('Last login: today\r\n');
    vi.advanceTimersByTime(5000);
    expect(write).not.toHaveBeenCalled();

    input.onOutput(`${MARKER}user@mac project % `);
    vi.advanceTimersByTime(TIMING.settleMs - 1);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledExactlyOnceWith(LONG);

    // Later prompts change nothing.
    input.onOutput(MARKER);
    vi.advanceTimersByTime(TIMING.fallbackMs);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('finds a marker split across two chunks', () => {
    const write = vi.fn();
    const input = sendInitialInput(LONG, write, 'linux', TIMING);
    input.onOutput(`motd\r\n${MARKER.slice(0, 9)}`);
    input.onOutput(`${MARKER.slice(9)}$ `);
    vi.advanceTimersByTime(TIMING.settleMs);
    expect(write).toHaveBeenCalledExactlyOnceWith(LONG);
  });

  it('writes it anyway when the shell never reports a prompt', () => {
    const write = vi.fn();
    sendInitialInput(LONG, write, 'darwin', TIMING);
    vi.advanceTimersByTime(TIMING.fallbackMs);
    expect(write).toHaveBeenCalledExactlyOnceWith(LONG);
  });

  it('writes nothing once the session is gone', () => {
    const write = vi.fn();
    const input = sendInitialInput(LONG, write, 'darwin', TIMING);
    input.onOutput(MARKER);
    input.dispose();
    vi.advanceTimersByTime(TIMING.fallbackMs);
    expect(write).not.toHaveBeenCalled();
  });
});
