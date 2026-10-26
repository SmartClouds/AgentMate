import { defaultGrammarSettings, type GrammarSettings } from '@runova/core';
import type { GrammarCheckResult, GrammarIssue } from '@shared/grammar';
import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFieldGrammar } from '@/lib/grammarRegistry';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';
import { useGrammarCheck } from './useGrammarCheck';

/**
 * Live checking talks to a rate-limited public endpoint, so the two things that matter most here
 * are the debounce (one check per pause, not one per keystroke) and the guard that stops a slow
 * check from overwriting a newer one's result.
 */

const DEBOUNCE_MS = 1400;

function issue(overrides: Partial<GrammarIssue> = {}): GrammarIssue {
  return {
    offset: 0,
    length: 4,
    text: 'teh',
    message: 'Possible spelling mistake',
    shortMessage: 'Spelling',
    kind: 'spelling',
    ruleId: 'MORFOLOGIK_RULE_EN_US',
    categoryName: 'Possible Typo',
    replacements: ['the'],
    ...overrides,
  };
}

function result(
  issues: GrammarIssue[],
  overrides: Partial<GrammarCheckResult> = {},
): GrammarCheckResult {
  return { issues, language: 'English (US)', source: 'online', truncatedAt: null, ...overrides };
}

/**
 * A distinctive language, so a test can tell the saved settings from the defaults the hook uses
 * while the settings query is still in flight. That matters because a settings change resets the
 * hook's error, which would otherwise race with the assertions below.
 */
function settings(overrides: Partial<GrammarSettings> = {}): { grammar: GrammarSettings } {
  return { grammar: { ...defaultGrammarSettings(), language: 'en-US', ...overrides } };
}

/** Resolves once the saved settings have actually reached the hook. */
async function settingsArrived(read: () => GrammarSettings): Promise<void> {
  await waitFor(() => expect(read().language).toBe('en-US'));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useGrammarCheck', () => {
  it('checks after the typing pause, not on every keystroke', async () => {
    const check = vi.fn(async () => result([issue({ offset: 6, length: 3, text: 'teh' })]));
    const {
      result: hook,
      rerender,
      bridge,
    } = renderHookWithProviders(
      ({ value }: { value: string }) => useGrammarCheck({ value, field: null }),
      {
        initialProps: { value: '' },
        bridge: { 'settings.get': settings(), 'grammar.check': check },
      },
    );

    await settingsArrived(() => hook.current.settings);
    expect(hook.current.active).toBe(true);

    // Three keystrokes in quick succession, each restarting the timer.
    rerender({ value: 'I saw' });
    rerender({ value: 'I saw t' });
    rerender({ value: 'I saw teh' });
    expect(check).not.toHaveBeenCalled();

    await waitFor(() => expect(check).toHaveBeenCalledTimes(1), { timeout: DEBOUNCE_MS + 1500 });
    expect(bridge.$fn('grammar.check')).toHaveBeenCalledWith({ text: 'I saw teh' });
    await waitFor(() => expect(hook.current.issues).toHaveLength(1));
    expect(hook.current.language).toBe('English (US)');
  });

  it('does not check while live checking is switched off', async () => {
    const check = vi.fn(async () => result([]));
    const { result: hook, rerender } = renderHookWithProviders(
      ({ value }: { value: string }) => useGrammarCheck({ value, field: null }),
      {
        initialProps: { value: '' },
        bridge: { 'settings.get': settings({ liveCheck: false }), 'grammar.check': check },
      },
    );

    await settingsArrived(() => hook.current.settings);
    expect(hook.current.settings.liveCheck).toBe(false);
    rerender({ value: 'some prose with teh typo' });
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 200));
    expect(check).not.toHaveBeenCalled();
    // The host can still ask for one by hand, which is what the writing button does.
    await act(async () => {
      await hook.current.recheck();
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('reports itself inactive when the feature is off, so hosts can hide the button', async () => {
    const { result: hook } = renderHookWithProviders(
      () => useGrammarCheck({ value: 'text', field: null }),
      { bridge: { 'settings.get': settings({ enabled: false }) } },
    );
    await waitFor(() => expect(hook.current.active).toBe(false));
  });

  it('stays inactive for a field that opted out, such as one holding CLI arguments', async () => {
    const { result: hook } = renderHookWithProviders(
      () => useGrammarCheck({ value: '--model haiku', field: null, enabled: false }),
      { bridge: { 'settings.get': settings() } },
    );
    await settingsArrived(() => hook.current.settings);
    expect(hook.current.settings.enabled).toBe(true);
    expect(hook.current.active).toBe(false);
    expect(hook.current.issues).toEqual([]);
  });

  // The whole reason requestIdRef exists: a check that started on older text must not win.
  it('discards a slow check once a newer one has started', async () => {
    const gates: Array<(value: GrammarCheckResult) => void> = [];
    const check = vi.fn(
      () =>
        new Promise<GrammarCheckResult>((resolve) => {
          gates.push(resolve);
        }),
    );
    const { result: hook } = renderHookWithProviders(
      () => useGrammarCheck({ value: 'I saw teh cat', field: null }),
      { bridge: { 'settings.get': settings(), 'grammar.check': check } },
    );

    await settingsArrived(() => hook.current.settings);
    expect(hook.current.active).toBe(true);

    // Two checks in flight: the second one supersedes the first.
    await act(async () => {
      void hook.current.recheck();
      void hook.current.recheck();
    });
    await waitFor(() => expect(gates).toHaveLength(2));

    const stale = issue({ offset: 0, length: 5, text: 'I saw' });
    const fresh = issue({ offset: 6, length: 3, text: 'teh' });
    await act(async () => {
      gates[1]?.(result([fresh]));
      gates[0]?.(result([stale]));
      await Promise.resolve();
    });

    await waitFor(() => expect(hook.current.issues).toHaveLength(1));
    expect(hook.current.issues[0]?.text).toBe('teh');
  });

  it('surfaces the error when a check fails, and clears it on the next success', async () => {
    let fail = true;
    const { result: hook } = renderHookWithProviders(
      () => useGrammarCheck({ value: 'I saw teh cat', field: null }),
      {
        bridge: {
          'settings.get': settings(),
          'grammar.check': async () => {
            if (fail) throw new Error('LanguageTool refused the request');
            return result([]);
          },
        },
      },
    );

    await settingsArrived(() => hook.current.settings);
    expect(hook.current.active).toBe(true);
    await act(async () => {
      await hook.current.recheck();
    });
    await waitFor(() => expect(hook.current.error).toBe('LanguageTool refused the request'));

    fail = false;
    await act(async () => {
      await hook.current.recheck();
    });
    await waitFor(() => expect(hook.current.error).toBeNull());
  });

  it('drops issues whose offsets no longer match the text', async () => {
    const { result: hook, rerender } = renderHookWithProviders(
      ({ value }: { value: string }) => useGrammarCheck({ value, field: null }),
      {
        initialProps: { value: 'I saw teh cat' },
        bridge: {
          'settings.get': settings(),
          'grammar.check': async () => result([issue({ offset: 6, length: 3, text: 'teh' })]),
        },
      },
    );

    await settingsArrived(() => hook.current.settings);
    expect(hook.current.active).toBe(true);
    await act(async () => {
      await hook.current.recheck();
    });
    await waitFor(() => expect(hook.current.issues).toHaveLength(1));

    // The typo was fixed, so the underline has to go even before the next check lands.
    rerender({ value: 'I saw the cat' });
    expect(hook.current.issues).toHaveLength(0);
  });

  it('hides a dismissed issue and does not bring it back on the next check', async () => {
    const found = issue({ offset: 6, length: 3, text: 'teh' });
    const { result: hook } = renderHookWithProviders(
      () => useGrammarCheck({ value: 'I saw teh cat', field: null }),
      {
        bridge: {
          'settings.get': settings(),
          'grammar.check': async () => result([found]),
        },
      },
    );

    await settingsArrived(() => hook.current.settings);
    expect(hook.current.active).toBe(true);
    await act(async () => {
      await hook.current.recheck();
    });
    await waitFor(() => expect(hook.current.issues).toHaveLength(1));

    act(() => hook.current.dismiss(found));
    expect(hook.current.issues).toHaveLength(0);

    await act(async () => {
      await hook.current.recheck();
    });
    expect(hook.current.issues).toHaveLength(0);
  });

  it('passes the truncation point through so the UI can say the tail was not checked', async () => {
    const { result: hook } = renderHookWithProviders(
      () => useGrammarCheck({ value: 'a long document', field: null }),
      {
        bridge: {
          'settings.get': settings(),
          'grammar.check': async () => result([], { truncatedAt: 20_000 }),
        },
      },
    );

    await settingsArrived(() => hook.current.settings);
    expect(hook.current.active).toBe(true);
    await act(async () => {
      await hook.current.recheck();
    });
    await waitFor(() => expect(hook.current.truncatedAt).toBe(20_000));
  });

  // The app-wide writing menu has no props from the field that was right-clicked, so a live
  // field has to publish itself. Losing that registration is how "Ignore" stops working.
  it('publishes the field for the writing menu and withdraws it on unmount', async () => {
    const field = document.createElement('textarea');
    field.value = 'I saw teh cat';
    document.body.append(field);

    const { result: hook, unmount } = renderHookWithProviders(
      () => useGrammarCheck({ value: 'I saw teh cat', field }),
      {
        bridge: {
          'settings.get': settings(),
          'grammar.check': async () => result([issue({ offset: 6, length: 3, text: 'teh' })]),
        },
      },
    );

    await settingsArrived(() => hook.current.settings);
    expect(hook.current.active).toBe(true);
    await waitFor(() => expect(getFieldGrammar(field)).not.toBeNull());
    expect(getFieldGrammar(field)?.value).toBe('I saw teh cat');

    unmount();
    expect(getFieldGrammar(field)).toBeNull();
    field.remove();
  });
});
