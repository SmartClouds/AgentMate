import { HELP_ARTICLES, helpArticlesByCategory } from '@shared/help/articles';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAskAiStore } from '@/stores/askAiStore';
import { useHelpStore } from '@/stores/helpStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';
import HelpPage from './HelpPage';

/**
 * The Help page: browsing the bundled articles, searching them, reading one, and asking the guide,
 * which answers from them when an AI provider is set up.
 */

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <span data-testid="path">{`${location.pathname}${location.search}${location.hash}`}</span>;
}

const CONFIGURED = {
  openaiApiKey: 'sk-test',
  openaiModel: 'gpt-test',
  geminiApiKey: null,
  ollamaModel: '',
  geminiModel: '',
};

function renderHelp(route = '/help', bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <HelpPage />
      <LocationProbe />
    </>,
    {
      route,
      bridge: {
        'settings.get': CONFIGURED,
        'help.status': { chunks: 40, embedded: 40, backend: 'sqlite-vec', embedder: 'openai:x' },
        ...bridge,
      },
    },
  );
}

const path = (): string => screen.getByTestId('path').textContent ?? '';

beforeEach(() => {
  act(() => {
    useHelpStore.setState({ messages: [], chatOpen: false });
    useAskAiStore.setState({ provider: 'openai', openaiModel: 'gpt-test' });
  });
});

describe('Help home', () => {
  it('lists every category with its articles', () => {
    renderHelp();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Find your way around Runova',
    );
    for (const group of helpArticlesByCategory()) {
      const section = screen.getByRole('region', { name: group.category });
      for (const article of group.articles) {
        const link = within(section)
          .getAllByRole('link')
          .find((a) => a.getAttribute('href') === `/help/${article.slug}`);
        expect(link?.textContent, article.slug).toContain(article.title);
      }
    }
  });

  it('opens an article from the map', async () => {
    const { user } = renderHelp();
    const first = HELP_ARTICLES[0]!;
    await user.click(screen.getAllByRole('link', { name: new RegExp(first.title) })[0]!);
    expect(path()).toBe(`/help/${first.slug}`);
  });
});

describe('Help search', () => {
  it('shows matching sections as you type and opens one with Enter', async () => {
    const { user } = renderHelp();
    const box = screen.getByRole('combobox', { name: /search the help/i });
    await user.type(box, 'vault master password');
    const listbox = await screen.findByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(path()).toMatch(/^\/help\/[a-z-]+/);
  });

  it('moves through results with the arrow keys', async () => {
    const { user } = renderHelp();
    await user.type(screen.getByRole('combobox', { name: /search the help/i }), 'terminal');
    const options = within(await screen.findByRole('listbox')).getAllByRole('option');
    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('says so when nothing matches', async () => {
    const { user } = renderHelp();
    await user.type(screen.getByRole('combobox', { name: /search the help/i }), 'qqqzzzxxx');
    expect(await screen.findByText(/no articles match/i)).toBeTruthy();
  });

  it('clears the search with Escape, then leaves the box with a second Escape', async () => {
    const { user } = renderHelp();
    const box = screen.getByRole('combobox', { name: /search the help/i });
    await user.type(box, 'vault');
    expect(await screen.findByRole('listbox')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(box).toHaveValue('');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(box);
    await user.keyboard('{Escape}');
    expect(document.activeElement).not.toBe(box);
  });

  it('focuses the search box when you press slash', async () => {
    const { user } = renderHelp('/help/vault');
    await user.keyboard('/');
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: /search the help/i }));
  });
});

describe('Help article', () => {
  it('shows the article with its sections and an outline', () => {
    renderHelp('/help/vault');
    const article = screen.getByRole('article');
    expect(within(article).getByRole('heading', { level: 1 }).textContent).toBe('Vault');
    expect(
      within(article).getByRole('heading', { level: 2, name: 'Where to find it' }),
    ).toHaveAttribute('id', 'where-to-find-it');
    const outline = screen.getByRole('navigation', { name: /on this page/i });
    expect(within(outline).getByRole('link', { name: 'Where to find it' })).toBeTruthy();
  });

  it('jumps to the part of the app the article is about', async () => {
    const { user } = renderHelp('/help/vault');
    await user.click(screen.getByRole('button', { name: /open vault/i }));
    expect(path()).toBe('/vault');
  });

  it('follows links between articles inside the Help page', async () => {
    const { user } = renderHelp('/help/vault');
    const article = screen.getByRole('article');
    const link = within(article)
      .getAllByRole('link')
      .find(
        (a) =>
          a.getAttribute('href')?.startsWith('/help/') &&
          !a.getAttribute('href')?.startsWith('/help/vault'),
      );
    expect(link).toBeTruthy();
    const target = link!.getAttribute('href')!;
    await user.click(link!);
    expect(path()).toBe(target);
  });

  it('never calls scrollIntoView, which would push the shell header out of view', async () => {
    // jsdom lacks scrollIntoView, so define it for the spy; restored afterwards.
    const original = Element.prototype.scrollIntoView;
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    try {
      const home = renderHelp('/help');
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });
      home.unmount();
      renderHelp('/help/vault#where-to-find-it');
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('marks the open article in the topic list and keeps the way back to all topics', () => {
    renderHelp('/help/vault');
    const topics = screen.getByRole('navigation', { name: 'Help topics' });
    const current = within(topics).getByRole('link', { name: 'Vault' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(
      within(topics)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page'),
    ).toHaveLength(1);
    expect(screen.getByRole('link', { name: /all help topics/i })).toHaveAttribute('href', '/help');
  });

  it('offers the way back for an unknown article', () => {
    renderHelp('/help/no-such-page');
    expect(screen.getByText(/couldn't find that article/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /all help topics/i })).toHaveAttribute('href', '/help');
  });
});

describe('Ask the guide', () => {
  it('answers from the help and links the sources it cites', async () => {
    const { user, bridge } = renderHelp('/help', {
      'help.ask': {
        ok: true,
        text: 'Open **Vault** from the sidebar [1].',
        sources: [
          {
            n: 1,
            slug: 'vault',
            anchor: 'where-to-find-it',
            articleTitle: 'Vault',
            heading: 'Where to find it',
          },
        ],
        retrieval: 'hybrid',
      },
    });
    await user.click(screen.getByRole('button', { name: /ask the guide/i }));
    const panel = await screen.findByRole('complementary', { name: /guide/i });
    await user.type(
      within(panel).getByRole('textbox', { name: /ask a question/i }),
      'Where is the vault?{Enter}',
    );

    await waitFor(() => expect(bridge.$fn('help.ask')).toHaveBeenCalled());
    expect(bridge.$fn('help.ask').mock.calls[0]![0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
      question: 'Where is the vault?',
      history: [],
    });
    expect(await within(panel).findByText('Vault', { selector: 'strong' })).toBeTruthy();
    const source = within(panel).getByRole('link', { name: /Vault.*Where to find it/ });
    expect(source).toHaveAttribute('href', '/help/vault#where-to-find-it');
    const citation = within(panel).getByRole('link', { name: 'Source 1' });
    await user.click(citation);
    expect(path()).toBe('/help/vault#where-to-find-it');
  });

  it('picks the provider and sends only once there is a question', async () => {
    const { user } = renderHelp();
    await user.click(screen.getByRole('button', { name: /ask the guide/i }));
    const panel = await screen.findByRole('complementary', { name: /guide/i });
    const providers = within(panel).getByRole('radiogroup', { name: 'AI provider' });
    expect(within(providers).getByRole('radio', { name: 'OpenAI' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Only OpenAI has a key in these settings, so the others cannot be picked.
    expect(within(providers).getByRole('radio', { name: 'Gemini' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(within(panel).getByRole('textbox', { name: /ask a question/i }), 'hi');
    // Queried again: the tooltip drops its wrapper once the button can be pressed.
    expect(within(panel).getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('shows what went wrong when the provider fails', async () => {
    const { user } = renderHelp('/help', {
      'help.ask': { ok: false, text: '', sources: [], error: 'Incorrect API key provided.' },
    });
    await user.click(screen.getByRole('button', { name: /ask the guide/i }));
    const panel = await screen.findByRole('complementary', { name: /guide/i });
    await user.type(within(panel).getByRole('textbox', { name: /ask a question/i }), 'hi{Enter}');
    expect(await within(panel).findByText('Incorrect API key provided.')).toBeTruthy();
  });

  it('points to Settings when no AI provider is set up', async () => {
    const { user } = renderHelp('/help', {
      'settings.get': { ...CONFIGURED, openaiApiKey: null },
    });
    await user.click(screen.getByRole('button', { name: /ask the guide/i }));
    const panel = await screen.findByRole('complementary', { name: /guide/i });
    await user.click(await within(panel).findByRole('button', { name: /set up a provider/i }));
    expect(path()).toBe('/settings?tab=ai');
  });
});
