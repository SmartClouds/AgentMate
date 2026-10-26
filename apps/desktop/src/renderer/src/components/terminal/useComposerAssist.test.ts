import { act, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithProviders } from '../../../../test/renderer/renderWithProviders';
import type { FakeBridge } from '../../../../test/renderer/runovaBridge';
import { type ComposerAssistOptions, useComposerAssist } from './useComposerAssist';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const SETTINGS = { promptBuilderProvider: 'openai', openaiModel: 'gpt-test' };

/** The hook with its text kept in state, the way a composer holds it. */
function renderAssist(
  initial: string,
  options: Partial<Omit<ComposerAssistOptions, 'value' | 'onChange'>> = {},
  bridge: Record<string, unknown> = {},
) {
  return renderHookWithProviders(
    () => {
      const [value, setValue] = useState(initial);
      const assist = useComposerAssist({
        value,
        onChange: setValue,
        purpose: 'task',
        target: 'ssh',
        ...options,
      });
      return { value, setValue, assist };
    },
    { bridge: { 'settings.get': SETTINGS, ...bridge } },
  );
}

/** A bridge answer that stays pending until the test settles it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The bridge hands out a call's mock on first use, so a call that never happened has none. */
function expectUntouched(bridge: FakeBridge, path: string): void {
  expect(() => bridge.$fn(path)).toThrow('has not been touched');
}

afterEach(() => {
  vi.mocked(toast.error).mockClear();
});

describe('translate', () => {
  it('replaces the text with its English translation', async () => {
    const { result, bridge } = renderAssist(
      'لاگ‌ها را پاک کن',
      {},
      {
        'translate.text': async () => 'Clear the logs',
      },
    );
    await act(() => result.current.assist.translate());
    expect(result.current.value).toBe('Clear the logs');
    expect(bridge.$fn('translate.text')).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'لاگ‌ها را پاک کن', targetLang: 'en' }),
    );
  });

  it('says so and keeps the text when the translation fails', async () => {
    const { result } = renderAssist(
      'سلام',
      {},
      {
        'translate.text': async () => {
          throw new Error('offline');
        },
      },
    );
    await act(() => result.current.assist.translate());
    expect(result.current.value).toBe('سلام');
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Translation failed/));
  });
});

describe('rewrite', () => {
  it('asks the AI from Settings to write the instruction and puts it in the box', async () => {
    const { result, bridge } = renderAssist(
      'disk full? clean logs',
      {},
      {
        'ai.ask': async () => ({ ok: true, text: '  Free up disk space by removing old logs.\n' }),
      },
    );
    await act(() => result.current.assist.rewrite());
    expect(result.current.value).toBe('Free up disk space by removing old logs.');
    const input = bridge.$fn('ai.ask').mock.calls[0]?.[0];
    expect(input).toMatchObject({ provider: 'openai', model: 'gpt-test' });
    expect(input.prompt).toContain('disk full? clean logs');
    expect(input.requestId).toEqual(expect.any(String));
  });

  it('puts the question into the request when the text answers one', async () => {
    const { result, bridge } = renderAssist(
      'the second',
      { purpose: 'answer', question: 'Which site?' },
      { 'ai.ask': async () => ({ ok: true, text: 'Reload the second site.' }) },
    );
    await act(() => result.current.assist.rewrite());
    expect(bridge.$fn('ai.ask').mock.calls[0]?.[0].prompt).toContain('Which site?');
  });

  it('points at Settings when no model is set, without asking anything', async () => {
    const { result, bridge } = renderAssist(
      'x',
      {},
      {
        'settings.get': { promptBuilderProvider: 'gemini', geminiModel: '  ' },
      },
    );
    await act(() => result.current.assist.rewrite());
    expect(toast.error).toHaveBeenCalledWith('Set a gemini model in Settings first.');
    expectUntouched(bridge, 'ai.ask');
    expect(result.current.value).toBe('x');
  });

  it('shows the AI error and keeps the text', async () => {
    const { result } = renderAssist(
      'x',
      {},
      {
        'ai.ask': async () => ({ ok: false, text: '', error: 'No API key.' }),
      },
    );
    await act(() => result.current.assist.rewrite());
    expect(toast.error).toHaveBeenCalledWith('No API key.');
    expect(result.current.value).toBe('x');
  });

  it('does nothing for an empty box', async () => {
    const { result, bridge } = renderAssist('   ');
    await act(() => result.current.assist.rewrite());
    expectUntouched(bridge, 'ai.ask');
  });
});

describe('busy and cancel', () => {
  it('reports which job runs, and cancel stops it in main and drops its late result', async () => {
    const pending = deferred<{ ok: boolean; text: string }>();
    const { result, bridge } = renderAssist(
      'x',
      {},
      {
        'ai.ask': () => pending.promise,
        'ai.cancel': async () => true,
      },
    );
    let job!: Promise<void>;
    act(() => {
      job = result.current.assist.rewrite();
    });
    await waitFor(() => expect(result.current.assist.busy).toBe('rewrite'));
    const requestId = bridge.$fn('ai.ask').mock.calls[0]?.[0].requestId;

    let cancelled = false;
    act(() => {
      cancelled = result.current.assist.cancel();
    });
    expect(cancelled).toBe(true);
    expect(bridge.$fn('ai.cancel')).toHaveBeenCalledWith(requestId);
    expect(result.current.assist.busy).toBeNull();

    await act(async () => {
      pending.resolve({ ok: true, text: 'Too late.' });
      await job;
    });
    expect(result.current.value).toBe('x');
  });

  it('cancels a translation through translate.cancel', async () => {
    const pending = deferred<string>();
    const { result, bridge } = renderAssist(
      'سلام',
      {},
      {
        'translate.text': () => pending.promise,
        'translate.cancel': async () => true,
      },
    );
    act(() => {
      void result.current.assist.translate();
    });
    await waitFor(() => expect(result.current.assist.busy).toBe('translate'));
    act(() => {
      result.current.assist.cancel();
    });
    expect(bridge.$fn('translate.cancel')).toHaveBeenCalledWith(
      bridge.$fn('translate.text').mock.calls[0]?.[0].requestId,
    );
  });

  it('cancel says there was nothing to stop when idle', () => {
    const { result } = renderAssist('x');
    expect(result.current.assist.cancel()).toBe(false);
  });

  it('ignores a second job while one is running', async () => {
    const pending = deferred<{ ok: boolean; text: string }>();
    const { result, bridge } = renderAssist(
      'سلام',
      {},
      {
        'ai.ask': () => pending.promise,
      },
    );
    act(() => {
      void result.current.assist.rewrite();
    });
    await waitFor(() => expect(result.current.assist.busy).toBe('rewrite'));
    await act(() => result.current.assist.translate());
    expectUntouched(bridge, 'translate.text');
  });
});

describe('undo', () => {
  it('brings back what was typed before a rewrite', async () => {
    const { result } = renderAssist(
      'rough note',
      {},
      {
        'ai.ask': async () => ({ ok: true, text: 'Clear instruction.' }),
      },
    );
    expect(result.current.assist.canUndo).toBe(false);
    await act(() => result.current.assist.rewrite());
    expect(result.current.assist.canUndo).toBe(true);
    act(() => result.current.assist.undo());
    expect(result.current.value).toBe('rough note');
    expect(result.current.assist.canUndo).toBe(false);
  });

  it('is gone once the user edits the result, so it never throws away their typing', async () => {
    const { result } = renderAssist('سلام', {}, { 'translate.text': async () => 'Hello' });
    await act(() => result.current.assist.translate());
    act(() => result.current.setValue('Hello there'));
    expect(result.current.assist.canUndo).toBe(false);
    act(() => result.current.assist.undo());
    expect(result.current.value).toBe('Hello there');
  });
});
