// @vitest-environment jsdom
import type { AppSettings } from '@runova/core';
import { useIsMutating } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  HelpEmbeddingModelOption,
  HelpIndexProgress,
  HelpIndexStatus,
  HelpReindexResult,
} from '../../../../shared/apiTypes';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * The Help search card: one row per provider with the embedding model the Help guide searches
 * with, how much of the index is built for it, and the buttons that build it. The tests drive the
 * card through the fake bridge, so what they check is what the card asks the main process for and
 * what it shows from the answers.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const { HelpSearchSettings } = await import('./HelpSearchSettings');

const OPENAI_DEFAULT = 'text-embedding-3-small';
const GEMINI_DEFAULT = 'gemini-embedding-001';
const OLLAMA_DEFAULT = 'nomic-embed-text';

/** Only the fields the card reads; a partial cast keeps each test about one thing. */
function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    openaiApiKey: 'sk-test',
    geminiApiKey: 'g-test',
    ollamaBaseUrl: 'http://localhost:11434',
    helpEmbeddingModels: {},
    ...overrides,
  } as AppSettings;
}

function status(overrides: Partial<HelpIndexStatus> = {}): HelpIndexStatus {
  return { chunks: 40, embedded: 0, backend: 'js', embedder: null, ...overrides };
}

const OPENAI_OPTIONS: HelpEmbeddingModelOption[] = [
  { value: OPENAI_DEFAULT, label: 'text-embedding-3-small (fast, low cost)' },
  { value: 'text-embedding-3-large', label: 'text-embedding-3-large (most accurate)' },
];

const OLLAMA_OPTIONS: HelpEmbeddingModelOption[] = [
  { value: OLLAMA_DEFAULT, label: 'nomic-embed-text', installed: true },
  { value: 'bge-m3', label: 'bge-m3', installed: false },
];

const DONE: HelpReindexResult = { ok: true, embedded: 40, total: 40, removedModels: [] };

/** A promise the test settles by hand, to hold a reindex in its running state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Setup {
  settings?: AppSettings;
  statuses?: Partial<Record<'openai' | 'gemini' | 'ollama', HelpIndexStatus>>;
  models?: Partial<Record<'openai' | 'gemini' | 'ollama', HelpEmbeddingModelOption[]>>;
  reindex?: (provider: string, opts: { fresh: boolean }) => Promise<HelpReindexResult>;
}

function renderCard({
  settings = makeSettings(),
  statuses = {},
  models = {},
  reindex,
}: Setup = {}) {
  return renderWithProviders(<HelpSearchSettings settings={settings} />, {
    bridge: {
      'help.status': async (provider: 'openai' | 'gemini' | 'ollama') =>
        statuses[provider] ?? status(),
      'help.embeddingModels': async (provider: 'openai' | 'gemini' | 'ollama') =>
        models[provider] ?? [],
      'help.reindex': reindex ?? (async () => DONE),
      'help.cancelReindex': async () => undefined,
      'settings.update': async (patch: unknown) => ({ ...settings, ...(patch as object) }),
    },
  });
}

/** One provider's row, found through its name so a check cannot catch another provider's text. */
function row(label: 'OpenAI' | 'Gemini' | 'Ollama'): HTMLElement {
  const name = screen.getByText(label, { selector: 'span' });
  const element = name.closest('.flex-col');
  if (!(element instanceof HTMLElement)) throw new Error(`No row for ${label}`);
  return element;
}

const picker = (label: 'OpenAI' | 'Gemini' | 'Ollama') =>
  screen.getByRole('combobox', { name: `${label} embedding model` });

/** The calls a bridge path has seen. `$fn` throws for a path nothing touched, which is also fine here. */
function callsTo(bridge: { $fn(path: string): { mock: { calls: unknown[][] } } }, path: string) {
  try {
    return bridge.$fn(path).mock.calls;
  } catch {
    return [];
  }
}

function emit(bridge: { $emit(path: string, ...args: unknown[]): void }, p: HelpIndexProgress) {
  act(() => bridge.$emit('help.onIndexProgress', p));
}

describe('HelpSearchSettings providers', () => {
  it('lists OpenAI, Gemini and Ollama under the Help search title', async () => {
    renderCard();

    expect(await screen.findByText('Help search')).toBeInTheDocument();
    for (const label of ['OpenAI', 'Gemini', 'Ollama'] as const) {
      expect(row(label)).toBeInTheDocument();
    }
  });

  it('asks for an API key first on a hosted provider that has none, and leaves it inert', async () => {
    const { bridge } = renderCard({
      settings: makeSettings({ openaiApiKey: null, geminiApiKey: '   ' }),
    });
    await screen.findByText('Help search');

    for (const label of ['OpenAI', 'Gemini'] as const) {
      const r = within(row(label));
      expect(r.getByText('Add an API key above first')).toBeInTheDocument();
      expect(picker(label)).toBeDisabled();
      expect(r.getByRole('button', { name: /Update index/ })).toBeDisabled();
      expect(r.queryByRole('progressbar')).toBeNull();
    }
    expect(screen.getAllByText('Add an API key above first')).toHaveLength(2);

    // Ollama needs no key, so it stays usable and is the only one that asks for anything.
    expect(picker('Ollama')).toBeEnabled();
    expect(within(row('Ollama')).getByRole('button', { name: /Update index/ })).toBeEnabled();
    await waitFor(() => expect(bridge.$fn('help.status')).toHaveBeenCalledWith('ollama'));
    expect(bridge.$fn('help.status')).not.toHaveBeenCalledWith('openai');
    expect(bridge.$fn('help.status')).not.toHaveBeenCalledWith('gemini');
    expect(bridge.$fn('help.embeddingModels')).not.toHaveBeenCalledWith('openai');
    expect(bridge.$fn('help.embeddingModels')).not.toHaveBeenCalledWith('gemini');
  });
});

describe('HelpSearchSettings model picker', () => {
  it('shows the catalog default for each provider when none was picked', async () => {
    renderCard();
    await screen.findByText('Help search');

    expect(picker('OpenAI')).toHaveTextContent(OPENAI_DEFAULT);
    expect(picker('Gemini')).toHaveTextContent(GEMINI_DEFAULT);
    expect(picker('Ollama')).toHaveTextContent(OLLAMA_DEFAULT);
  });

  it('shows the model saved in settings, even one the list does not know', async () => {
    renderCard({
      settings: makeSettings({
        helpEmbeddingModels: { openai: 'text-embedding-3-large', ollama: 'my-custom-embedder' },
      }),
      models: { openai: OPENAI_OPTIONS },
    });
    await screen.findByText('Help search');

    expect(picker('OpenAI')).toHaveTextContent('text-embedding-3-large');
    expect(picker('Ollama')).toHaveTextContent('my-custom-embedder');
    expect(picker('Gemini')).toHaveTextContent(GEMINI_DEFAULT);
  });

  it('lists the models the bridge returns and marks Ollama models that are not installed', async () => {
    const { user, bridge } = renderCard({ models: { ollama: OLLAMA_OPTIONS } });
    await screen.findByText('Help search');
    await waitFor(() => expect(bridge.$fn('help.embeddingModels')).toHaveBeenCalledWith('ollama'));

    await user.click(picker('Ollama'));

    expect(await screen.findByRole('option', { name: 'bge-m3 (not installed)' })).toBeVisible();
    // An installed model gets no suffix.
    expect(screen.getByRole('option', { name: 'nomic-embed-text' })).toBeVisible();
  });

  it('does not add the not installed suffix to hosted models', async () => {
    const { user } = renderCard({
      models: { openai: [...OPENAI_OPTIONS, { value: 'odd', label: 'odd', installed: false }] },
    });
    await screen.findByText('Help search');

    await user.click(picker('OpenAI'));

    expect(await screen.findByRole('option', { name: 'odd' })).toBeVisible();
    expect(screen.queryByText(/not installed/)).toBeNull();
  });

  it('saves a picked model next to the ones already saved, then indexes with it', async () => {
    const { user, bridge } = renderCard({
      settings: makeSettings({ helpEmbeddingModels: { gemini: 'gemini-x' } }),
      models: { openai: OPENAI_OPTIONS },
    });
    await screen.findByText('Help search');
    await waitFor(() => expect(bridge.$fn('help.embeddingModels')).toHaveBeenCalledWith('openai'));

    await user.click(picker('OpenAI'));
    await user.click(await screen.findByRole('option', { name: /text-embedding-3-large/ }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        helpEmbeddingModels: { gemini: 'gemini-x', openai: 'text-embedding-3-large' },
      }),
    );
    await waitFor(() =>
      expect(bridge.$fn('help.reindex')).toHaveBeenCalledWith('openai', { fresh: false }),
    );
    // Saving comes first, so the index is never built for a model that was not stored.
    expect(bridge.$fn('settings.update').mock.invocationCallOrder[0]).toBeLessThan(
      bridge.$fn('help.reindex').mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('saves a model typed into the picker', async () => {
    const { user, bridge } = renderCard({ models: { ollama: OLLAMA_OPTIONS } });
    await screen.findByText('Help search');

    await user.click(picker('Ollama'));
    await user.type(await screen.findByPlaceholderText('Search…'), 'mxbai-embed-large');
    await user.click(await screen.findByRole('option', { name: 'Use "mxbai-embed-large"' }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        helpEmbeddingModels: { ollama: 'mxbai-embed-large' },
      }),
    );
    await waitFor(() =>
      expect(bridge.$fn('help.reindex')).toHaveBeenCalledWith('ollama', { fresh: false }),
    );
  });

  it('does nothing when the current model is picked again', async () => {
    const { user, bridge } = renderCard({ models: { openai: OPENAI_OPTIONS } });
    await screen.findByText('Help search');
    await waitFor(() => expect(bridge.$fn('help.embeddingModels')).toHaveBeenCalledWith('openai'));

    await user.click(picker('OpenAI'));
    await user.click(await screen.findByRole('option', { name: /text-embedding-3-small/ }));

    // Let a stray save show up if there were one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(bridge, 'settings.update')).toHaveLength(0);
    expect(callsTo(bridge, 'help.reindex')).toHaveLength(0);
  });

  it('reports a failed save and does not start indexing', async () => {
    const { user, bridge } = renderWithProviders(<HelpSearchSettings settings={makeSettings()} />, {
      bridge: {
        'help.status': async () => status(),
        'help.embeddingModels': async () => OPENAI_OPTIONS,
        'help.reindex': async () => DONE,
        'settings.update': async () => {
          throw new Error('Disk is full');
        },
      },
    });
    await screen.findByText('Help search');
    await waitFor(() => expect(bridge.$fn('help.embeddingModels')).toHaveBeenCalledWith('openai'));

    await user.click(picker('OpenAI'));
    await user.click(await screen.findByRole('option', { name: /text-embedding-3-large/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Disk is full'));
    expect(callsTo(bridge, 'help.reindex')).toHaveLength(0);
  });
});

describe('HelpSearchSettings index status', () => {
  it('shows how many passages are indexed with the current model and offers Update index', async () => {
    const { user, bridge } = renderCard({
      statuses: {
        openai: status({ chunks: 40, embedded: 10, embedder: `openai:${OPENAI_DEFAULT}` }),
      },
    });

    const r = within(row('OpenAI'));
    expect(
      await r.findByText(`10 of 40 passages indexed with ${OPENAI_DEFAULT}.`),
    ).toBeInTheDocument();
    expect(r.queryByText('Indexed')).toBeNull();
    expect(r.getByRole('progressbar', { name: 'OpenAI help index' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );

    await user.click(r.getByRole('button', { name: /Update index/ }));

    await waitFor(() =>
      expect(bridge.$fn('help.reindex')).toHaveBeenCalledWith('openai', { fresh: false }),
    );
  });

  it('shows Indexed and Rebuild index once every passage has a vector, and rebuilds fresh', async () => {
    const { user, bridge } = renderCard({
      statuses: {
        gemini: status({ chunks: 32, embedded: 32, embedder: `gemini:${GEMINI_DEFAULT}` }),
      },
    });

    const r = within(row('Gemini'));
    expect(await r.findByText('Indexed')).toBeInTheDocument();
    expect(r.getByText(`32 of 32 passages indexed with ${GEMINI_DEFAULT}.`)).toBeInTheDocument();
    expect(r.getByRole('progressbar', { name: 'Gemini help index' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
    expect(r.queryByRole('button', { name: /Update index/ })).toBeNull();

    await user.click(r.getByRole('button', { name: /Rebuild index/ }));

    await waitFor(() =>
      expect(bridge.$fn('help.reindex')).toHaveBeenCalledWith('gemini', { fresh: true }),
    );
  });

  it('counts nothing as indexed when the index was built with another model', async () => {
    renderCard({
      statuses: {
        openai: status({ chunks: 40, embedded: 40, embedder: 'openai:text-embedding-3-large' }),
      },
    });

    const r = within(row('OpenAI'));
    expect(
      await r.findByText(`0 of 40 passages indexed with ${OPENAI_DEFAULT}.`),
    ).toBeInTheDocument();
    expect(r.queryByText('Indexed')).toBeNull();
    expect(r.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(r.getByRole('button', { name: /Update index/ })).toBeInTheDocument();
  });

  it('measures the index against the model saved in settings', async () => {
    renderCard({
      settings: makeSettings({ helpEmbeddingModels: { openai: 'text-embedding-3-large' } }),
      statuses: {
        openai: status({ chunks: 40, embedded: 40, embedder: 'openai:text-embedding-3-large' }),
      },
    });

    const r = within(row('OpenAI'));
    expect(
      await r.findByText('40 of 40 passages indexed with text-embedding-3-large.'),
    ).toBeInTheDocument();
    expect(r.getByText('Indexed')).toBeInTheDocument();
  });

  it('says when the index is searched with sqlite-vec', async () => {
    renderCard({
      statuses: {
        openai: status({
          chunks: 8,
          embedded: 8,
          backend: 'sqlite-vec',
          embedder: `openai:${OPENAI_DEFAULT}`,
        }),
      },
    });

    expect(await screen.findByText(/, searched with sqlite-vec\.$/)).toBeInTheDocument();
  });

  it('explains that an empty index is built the first time it is needed', async () => {
    renderCard({ statuses: { ollama: status({ chunks: 0, embedded: 0 }) } });

    expect(
      await within(row('Ollama')).findByText('The index is built the first time it is needed.'),
    ).toBeInTheDocument();
    expect(within(row('Ollama')).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });
});

describe('HelpSearchSettings while indexing', () => {
  /** Starts an OpenAI reindex that stays running until the returned `finish` is called. */
  async function startRunning(setup: Setup = {}) {
    const pending = deferred<HelpReindexResult>();
    const view = renderCard({
      ...setup,
      reindex: () => pending.promise,
      statuses: {
        openai: status({ chunks: 40, embedded: 0, embedder: `openai:${OPENAI_DEFAULT}` }),
      },
    });
    const r = within(row('OpenAI'));
    await r.findByText(`0 of 40 passages indexed with ${OPENAI_DEFAULT}.`);
    await view.user.click(r.getByRole('button', { name: /Update index/ }));
    await r.findByRole('button', { name: /Stop/ });
    return { ...view, r, finish: (result: HelpReindexResult) => pending.resolve(result) };
  }

  it('swaps the update button for Stop and locks the picker', async () => {
    const { r, finish } = await startRunning();

    expect(r.queryByRole('button', { name: /Update index/ })).toBeNull();
    expect(picker('OpenAI')).toBeDisabled();
    expect(r.getByText(`Indexing with ${OPENAI_DEFAULT}: 0 of 40 passages`)).toBeInTheDocument();

    await act(async () => finish(DONE));
  });

  it('follows the progress events of its own embedder', async () => {
    const { r, bridge, finish } = await startRunning();

    emit(bridge, { embedder: `openai:${OPENAI_DEFAULT}`, done: 10, total: 40 });

    expect(
      await r.findByText(`Indexing with ${OPENAI_DEFAULT}: 10 of 40 passages`),
    ).toBeInTheDocument();
    expect(r.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');

    emit(bridge, { embedder: `openai:${OPENAI_DEFAULT}`, done: 30, total: 40 });
    expect(
      await r.findByText(`Indexing with ${OPENAI_DEFAULT}: 30 of 40 passages`),
    ).toBeInTheDocument();
    expect(r.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75');

    await act(async () => finish(DONE));
  });

  it('ignores progress that belongs to another embedder', async () => {
    const { r, bridge, finish } = await startRunning();

    emit(bridge, { embedder: 'openai:text-embedding-3-large', done: 20, total: 40 });
    emit(bridge, { embedder: `gemini:${GEMINI_DEFAULT}`, done: 20, total: 40 });

    expect(r.getByText(`Indexing with ${OPENAI_DEFAULT}: 0 of 40 passages`)).toBeInTheDocument();
    expect(r.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    // The Gemini row is not running either, so it does not take the event.
    expect(within(row('Gemini')).queryByText(/^Indexing with/)).toBeNull();

    await act(async () => finish(DONE));
  });

  it('stops the index of its own provider when Stop is clicked', async () => {
    const { r, user, bridge, finish } = await startRunning();

    await user.click(r.getByRole('button', { name: /Stop/ }));

    expect(bridge.$fn('help.cancelReindex')).toHaveBeenCalledTimes(1);
    expect(bridge.$fn('help.cancelReindex')).toHaveBeenCalledWith('openai');

    await act(async () =>
      finish({ ok: false, cancelled: true, embedded: 12, total: 40, removedModels: [] }),
    );
  });

  it('shows the Update index button again, and refreshes the status, when it finishes', async () => {
    const { r, bridge, finish } = await startRunning();
    bridge.$set('help.status', async () =>
      status({ chunks: 40, embedded: 40, embedder: `openai:${OPENAI_DEFAULT}` }),
    );

    await act(async () => finish(DONE));

    expect(await r.findByText('Indexed')).toBeInTheDocument();
    expect(r.getByRole('button', { name: /Rebuild index/ })).toBeInTheDocument();
    expect(r.queryByRole('button', { name: /Stop/ })).toBeNull();
    expect(picker('OpenAI')).toBeEnabled();
  });

  it('keeps the other providers usable while one is indexing', async () => {
    const { finish } = await startRunning();

    expect(within(row('Gemini')).getByRole('button', { name: /Update index/ })).toBeEnabled();
    expect(picker('Gemini')).toBeEnabled();
    expect(within(row('Ollama')).getByRole('button', { name: /Update index/ })).toBeEnabled();

    await act(async () => finish(DONE));
  });
});

describe('HelpSearchSettings notices', () => {
  async function runOnce(result: HelpReindexResult | Error) {
    toast.success.mockClear();
    toast.error.mockClear();
    const view = renderCard({
      reindex: async () => {
        if (result instanceof Error) throw result;
        return result;
      },
    });
    const button = await within(row('OpenAI')).findByRole('button', { name: /Update index/ });
    await view.user.click(button);
    await waitFor(() => expect(view.bridge.$fn('help.reindex')).toHaveBeenCalled());
    // Wait for the row to settle back to its idle state before asserting on toasts.
    await within(row('OpenAI')).findByRole('button', { name: /Update index/ });
    return view;
  }

  it('says the help search is up to date after a successful run', async () => {
    await runOnce({ ok: true, embedded: 40, total: 40, removedModels: [] });

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('OpenAI help search is up to date (40 passages).'),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows the error the run reports', async () => {
    await runOnce({
      ok: false,
      embedded: 0,
      total: 40,
      removedModels: [],
      error: 'Invalid API key',
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Invalid API key'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('falls back to a general message when the run fails without one', async () => {
    await runOnce({ ok: false, embedded: 0, total: 40, removedModels: [] });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Indexing the help failed.'));
  });

  it('stays quiet when the run was cancelled', async () => {
    await runOnce({ ok: false, cancelled: true, embedded: 5, total: 40, removedModels: [] });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('HelpSearchSettings Ollama models', () => {
  it('tells the user to pull a picked model that is not installed', async () => {
    renderCard({
      settings: makeSettings({ helpEmbeddingModels: { ollama: 'bge-m3' } }),
      models: { ollama: OLLAMA_OPTIONS },
    });

    const r = within(row('Ollama'));
    const command = await r.findByText('ollama pull bge-m3');
    expect(command.tagName).toBe('CODE');
    expect(r.getByText(/This model is not on your Ollama server yet/)).toBeInTheDocument();
    // The picker also says so in the closed trigger.
    expect(picker('Ollama')).toHaveTextContent('bge-m3 (not installed)');
  });

  it('shows no pull hint for an installed model', async () => {
    renderCard({ models: { ollama: OLLAMA_OPTIONS } });
    const r = within(row('Ollama'));
    await r.findByText(`0 of 40 passages indexed with ${OLLAMA_DEFAULT}.`);

    await waitFor(() => expect(picker('Ollama')).toHaveTextContent(OLLAMA_DEFAULT));
    expect(r.queryByText(/ollama pull/)).toBeNull();
  });

  it('asks for a pull when the server does not list the picked model at all', async () => {
    renderCard({
      settings: makeSettings({ helpEmbeddingModels: { ollama: 'my-custom-embedder' } }),
      models: { ollama: OLLAMA_OPTIONS },
    });

    expect(
      await within(row('Ollama')).findByText('ollama pull my-custom-embedder'),
    ).toBeInTheDocument();
  });

  it('never shows the pull hint for the hosted providers', async () => {
    renderCard({
      settings: makeSettings({ helpEmbeddingModels: { openai: 'something-unlisted' } }),
      models: { openai: OPENAI_OPTIONS },
    });
    await screen.findByText('Help search');
    await within(row('OpenAI')).findByText(/passages indexed with something-unlisted/);

    expect(within(row('OpenAI')).queryByText(/ollama pull/)).toBeNull();
  });
});

describe('HelpSearchSettings and the loading overlay', () => {
  /** The rule useAppLoadingOverlay applies: every mutation not marked silent blanks the page. */
  function OverlayProbe(): React.JSX.Element {
    const blocking = useIsMutating({ predicate: (m) => !m.options.meta?.silentLoading });
    return <span data-testid="blocking">{blocking}</span>;
  }

  function renderWithProbe(bridge: Record<string, unknown>) {
    return renderWithProviders(
      <>
        <HelpSearchSettings settings={makeSettings()} />
        <OverlayProbe />
      </>,
      {
        bridge: {
          'help.status': status({ embedder: `openai:${OPENAI_DEFAULT}` }),
          'help.embeddingModels': OPENAI_OPTIONS,
          'help.onIndexProgress': () => () => undefined,
          ...bridge,
        },
      },
    );
  }

  it('keeps the page usable while an index is built, since the row shows its own progress', async () => {
    const run = deferred<HelpReindexResult>();
    const { user } = renderWithProbe({ 'help.reindex': () => run.promise });
    const [update] = await screen.findAllByRole('button', { name: /update index/i });
    await user.click(update!);
    await screen.findAllByRole('button', { name: /stop/i });
    expect(screen.getByTestId('blocking').textContent).toBe('0');
    await act(async () => run.resolve(DONE));
  });

  it('keeps the page usable while a new model is saved', async () => {
    const save = deferred<AppSettings>();
    const { user } = renderWithProbe({
      'settings.update': () => save.promise,
      'help.reindex': async () => DONE,
    });
    await user.click(await screen.findByRole('combobox', { name: 'OpenAI embedding model' }));
    await user.click(await screen.findByRole('option', { name: /text-embedding-3-large/ }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'OpenAI embedding model' })).toBeDisabled(),
    );
    expect(screen.getByTestId('blocking').textContent).toBe('0');
    await act(async () =>
      save.resolve(makeSettings({ helpEmbeddingModels: { openai: 'text-embedding-3-large' } })),
    );
  });
});
