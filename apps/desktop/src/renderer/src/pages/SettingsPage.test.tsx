// @vitest-environment jsdom
import type { AppSettings } from '@runova/core';
import { defaultGrammarSettings, defaultProxySettings, isStartupPage } from '@runova/core';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAV_ITEMS } from '@/components/layout/Sidebar';
import { queryKeys } from '@/lib/queryKeys';
import { useThemeStore } from '@/stores/themeStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * Settings is a long page of small forms, so these tests stay on the parts where a mistake is
 * expensive: landing on the section a deep link asked for, a theme that really reaches disk and
 * the document, the search that has to find a setting across every tab, and the backup pair,
 * where export writes a file and restore replaces everything on the machine.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/stores/confirmStore', () => confirm);

const { default: SettingsPage } = await import('./SettingsPage');

/**
 * Only the fields the sections under test read. The page treats settings as one object, so a
 * partial cast keeps the fixture to what each test is actually about.
 */
const settings = {
  theme: 'system',
  menuPosition: 'left',
  projectsRootPath: null,
  telegramBotToken: null,
  telegramChatId: null,
  telegramScheduledTasksChatId: null,
  openaiApiKey: null,
  openaiModel: 'gpt-4o-mini',
  geminiApiKey: null,
  geminiModel: 'gemini-2.0-flash',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'llama3',
  ollamaContextLength: null,
  ollamaKeepAlive: '5m',
  promptBuilderProvider: 'openai',
  translateMaxRetries: 3,
  speechModel: 'base',
  speechLanguage: 'auto',
  // Searching walks every tab as the query is typed, so the sections that read a nested object
  // (the proxy card, the writing check) have to find a real one here.
  proxy: defaultProxySettings(),
  grammar: defaultGrammarSettings(),
  keepTerminalsRunning: false,
  workspaceNotifications: true,
  terminalAiNotifications: true,
  checkToolUpdatesEnabled: true,
  startupPage: 'last',
  stopDockerWithRun: 'ask',
  idleResourceMinutes: 20,
  idleResourceNotify: true,
} as AppSettings;

function renderSettings(bridge: Record<string, unknown> = {}, route = '/settings') {
  return renderWithProviders(<SettingsPage />, {
    route,
    path: '/settings',
    bridge: {
      'settings.get': settings,
      // Every save hands the stored settings back, and several cards read the answer.
      'settings.update': async (patch: unknown) => ({
        ...settings,
        ...(patch as Partial<AppSettings>),
      }),
      ...bridge,
    },
  });
}

const categories = (): HTMLElement =>
  screen.getByRole('navigation', { name: 'Settings categories' });

/** A settings card by its title, so assertions about one section do not catch another. */
function card(title: string): HTMLElement {
  let element: HTMLElement | null = screen.getByText(title);
  while (element) {
    if (element.tagName === 'DIV' && element.className.includes('glass')) return element;
    element = element.parentElement;
  }
  throw new Error(`No card around "${title}"`);
}

afterEach(() => {
  // The theme writes straight onto <html>, which outlives a render.
  document.documentElement.classList.remove('dark', 'theme-vscode-dark', 'theme-vs2026');
});

describe('SettingsPage sections', () => {
  it('opens on General and lists every category', async () => {
    renderSettings();

    expect(await screen.findByText('Appearance')).toBeInTheDocument();
    expect(within(categories()).getByRole('button', { name: /General/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Sections belonging to other tabs stay out of the way until one is chosen.
    expect(screen.queryByText('Backup & restore')).toBeNull();
    expect(screen.queryByText('Telegram bot')).toBeNull();
  });

  it('lands on the section a ?tab= link asked for', async () => {
    renderSettings({}, '/settings?tab=notifications');

    expect(await screen.findByText('Telegram bot')).toBeInTheDocument();
    expect(screen.queryByText('Appearance')).toBeNull();
    expect(within(categories()).getByRole('button', { name: /Notifications/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('falls back to General when the link names a tab that does not exist', async () => {
    renderSettings({}, '/settings?tab=teleportation');

    expect(await screen.findByText('Appearance')).toBeInTheDocument();
    expect(within(categories()).getByRole('button', { name: /General/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('switches sections when a category is clicked', async () => {
    const { user } = renderSettings();
    await screen.findByText('Appearance');

    await user.click(within(categories()).getByRole('button', { name: /Data/ }));

    expect(await screen.findByText('Backup & restore')).toBeInTheDocument();
    expect(screen.queryByText('Appearance')).toBeNull();
  });

  it('offers a retry instead of empty cards when the settings cannot be read', async () => {
    const { user, bridge } = renderSettings({
      'settings.get': () => Promise.reject(new Error('database is locked')),
    });

    expect(await screen.findByText('Could not load settings')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(bridge.$fn('settings.get').mock.calls.length).toBeGreaterThan(1));
  });
});

describe('SettingsPage appearance', () => {
  it('applies a theme to the document and remembers it on this machine', async () => {
    const { user, bridge } = renderSettings();
    const group = within(await screen.findByRole('group', { name: 'Theme' }));

    await user.click(group.getByRole('button', { name: /^Dark/ }));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ theme: 'dark' });
    expect(group.getByRole('button', { name: /^Dark/ })).toHaveAttribute('aria-pressed', 'true');
    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('swaps one theme’s classes for the next rather than stacking them', async () => {
    const { user, bridge } = renderSettings();
    const group = within(await screen.findByRole('group', { name: 'Theme' }));

    await user.click(group.getByRole('button', { name: /^VS Code Dark/ }));
    expect(document.documentElement.classList.contains('theme-vscode-dark')).toBe(true);

    await user.click(group.getByRole('button', { name: /^Light/ }));

    expect(document.documentElement.classList.contains('theme-vscode-dark')).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({ theme: 'light' });
  });

  it('draws the Light preview in light even while the app is dark', async () => {
    const { user } = renderSettings();
    const group = within(await screen.findByRole('group', { name: 'Theme' }));

    await user.click(group.getByRole('button', { name: /^Dark/ }));

    // Light has no class on <html>, so its preview needs its own to undo the inherited dark colours.
    const light = group.getByRole('button', { name: /^Light/ });
    expect(light.querySelector('.theme-light')).not.toBeNull();
    expect(light.querySelector('.dark')).toBeNull();
  });

  it('keeps the main menu on the left until the user moves it', async () => {
    renderSettings();
    const group = within(await screen.findByRole('group', { name: 'Main menu' }));

    expect(group.getByRole('button', { name: /^Left/ })).toHaveAttribute('aria-pressed', 'true');
    expect(group.getByRole('button', { name: /^Top/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('moves the main menu to the top and hands the saved settings to the shell', async () => {
    // Main keeps what was saved, so the refetch after the save has to read it back too.
    let saved: AppSettings = settings;
    const { user, bridge, queryClient } = renderSettings({
      'settings.get': async () => saved,
      'settings.update': async (patch: unknown) => {
        saved = { ...saved, ...(patch as Partial<AppSettings>) };
        return saved;
      },
    });
    const group = within(await screen.findByRole('group', { name: 'Main menu' }));

    await user.click(group.getByRole('button', { name: /^Top/ }));

    expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ menuPosition: 'top' });
    await waitFor(() =>
      expect(group.getByRole('button', { name: /^Top/ })).toHaveAttribute('aria-pressed', 'true'),
    );
    // The shell reads this same query, so the menu moves without waiting on a refetch.
    expect(queryClient.getQueryData<AppSettings>(queryKeys.settings)?.menuPosition).toBe('top');
  });
});

describe('SettingsPage CI auto-fix', () => {
  it('sits with the pipeline settings on the Notifications tab, and is found by search', async () => {
    renderSettings({}, '/settings?tab=notifications');
    expect(await screen.findByRole('heading', { name: 'CI auto-fix' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Agent CLI for auto-fix' })).toBeVisible();
  });
});

describe('SettingsPage news', () => {
  it('sits on the Notifications tab', async () => {
    renderSettings({}, '/settings?tab=notifications');
    expect(await screen.findByRole('switch', { name: 'Show news' })).toBeChecked();
    expect(
      screen.getByRole('combobox', { name: 'Notify me about security fixes at' }),
    ).toBeVisible();
  });

  it('is found by searching for security notifications', async () => {
    const { user } = renderSettings();
    await screen.findByText('Keep terminals running');

    await user.type(screen.getByLabelText('Search settings'), 'security fix');

    expect(await screen.findByRole('switch', { name: 'Show news' })).toBeVisible();
  });
});

describe('SettingsPage pipeline failures', () => {
  const NOTIFY = 'Show failed pipelines in notifications';
  const PET = 'Show failed pipelines on my AI Pet';
  const CLICK = 'When I click a failure';

  it('saves each way of hearing about a failure on its own', async () => {
    const { user, bridge } = renderSettings(
      {
        'settings.get': { ...settings, desktopPetEnabled: true, pipelineFailureOpen: 'pipelines' },
      },
      '/settings?tab=notifications',
    );
    await screen.findByText(NOTIFY);

    // A profile saved before the notice switch existed has no key, and that has to read as "on".
    expect(screen.getByRole('switch', { name: NOTIFY })).toBeChecked();
    expect(screen.getByRole('switch', { name: PET })).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: CLICK })).toHaveTextContent('Pipelines page');

    await user.click(screen.getByRole('switch', { name: NOTIFY }));
    await user.click(screen.getByRole('switch', { name: PET }));

    await waitFor(() => {
      const update = bridge.$fn('settings.update');
      expect(update).toHaveBeenCalledWith({ pipelineFailureNotify: false });
      expect(update).toHaveBeenCalledWith({ desktopPetPipelineOnFail: true });
    });
  });

  it.each([
    ['Project workspace', 'workspace'],
    ['Just dismiss it', 'none'],
  ])('saves %s as the place a failure click goes', async (label, value) => {
    const { user, bridge } = renderSettings(
      { 'settings.get': { ...settings, pipelineFailureOpen: 'pipelines' } },
      '/settings?tab=notifications',
    );
    await screen.findByText(NOTIFY);

    await user.click(screen.getByRole('combobox', { name: CLICK }));
    await user.click(await screen.findByRole('option', { name: label }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ pipelineFailureOpen: value }),
    );
  });

  it('keeps the pet switch off-limits until the pet itself is turned on', async () => {
    renderSettings({}, '/settings?tab=notifications');
    await screen.findByText(NOTIFY);

    expect(screen.getByRole('switch', { name: PET })).toBeDisabled();
    expect(screen.getByText(/Turn on My AI Pet in the AI Pet tab first/)).toBeInTheDocument();
  });

  it('is found by searching for a failed build', async () => {
    const { user } = renderSettings();
    await screen.findByText('Keep terminals running');

    await user.type(screen.getByLabelText('Search settings'), 'unread badge');

    expect(await screen.findByText(NOTIFY)).toBeInTheDocument();
    expect(screen.queryByText('Keep terminals running')).toBeNull();
  });
});

describe('SettingsPage general rows', () => {
  it('saves a switch from the shared card the moment it flips', async () => {
    const { user, bridge } = renderSettings();
    await screen.findByText('Keep terminals running');

    await user.click(screen.getByRole('switch', { name: 'Keep terminals running after quitting' }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ keepTerminalsRunning: true }),
    );
    // The one-control settings share a card rather than each taking a card of its own.
    expect(card('Keep terminals running')).toBe(card('Workspace notifications'));
  });

  it('shows only the matching rows of the shared card while searching', async () => {
    const { user } = renderSettings();
    await screen.findByText('Keep terminals running');

    await user.type(screen.getByLabelText('Search settings'), 'approval');

    expect(await screen.findByText('Terminal AI notifications')).toBeInTheDocument();
    expect(screen.queryByText('Keep terminals running')).toBeNull();
    expect(screen.queryByText('Workspace notifications')).toBeNull();
  });
});

describe('SettingsPage status bar limits', () => {
  it('has a switch per provider, all on for a settings file that predates them', async () => {
    renderSettings();
    await screen.findByText('Status bar limits');

    for (const name of ['Claude Code', 'Codex', 'Cursor']) {
      expect(
        screen.getByRole('switch', { name: `Show ${name} limits in the status bar` }),
      ).toBeChecked();
    }
  });

  it('hides one provider and keeps the others as they were', async () => {
    const { user, bridge } = renderSettings();
    await screen.findByText('Status bar limits');

    await user.click(screen.getByRole('switch', { name: 'Show Codex limits in the status bar' }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        statusBarUsage: { 'claude-code': true, codex: false, cursor: true },
      }),
    );
  });

  it('is found by searching for the status bar', async () => {
    const { user } = renderSettings();
    await screen.findByText('Status bar limits');

    await user.type(screen.getByLabelText('Search settings'), 'status bar');

    expect(await screen.findByText('Status bar limits')).toBeInTheDocument();
    expect(screen.queryByText('Keep terminals running')).toBeNull();
  });
});

describe('SettingsPage startup page', () => {
  it('opens on the last page unless the user picks another', async () => {
    renderSettings();
    await screen.findByText('Startup page');

    const picker = within(card('Startup page')).getByRole('combobox', { name: 'Startup page' });
    expect(picker).toHaveTextContent('Last opened page');
  });

  it('saves the page the user picks', async () => {
    const { user, bridge } = renderSettings();
    await screen.findByText('Startup page');

    await user.click(screen.getByRole('combobox', { name: 'Startup page' }));
    await user.click(await screen.findByRole('option', { name: /Dashboard/ }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({ startupPage: '/' }),
    );
  });

  it('finds the default view for agent tabs by searching for chat', async () => {
    const { user } = renderSettings();
    await screen.findByText('Appearance');

    await user.type(screen.getByLabelText('Search settings'), 'chat view');

    expect(await screen.findByText('Default view for agent tabs')).toBeInTheDocument();
    expect(screen.queryByText('Appearance')).toBeNull();
  });

  it('is found by searching for it', async () => {
    const { user } = renderSettings();
    await screen.findByText('Appearance');

    await user.type(screen.getByLabelText('Search settings'), 'startup');

    expect(await screen.findByText('Startup page')).toBeInTheDocument();
    expect(screen.queryByText('Appearance')).toBeNull();
  });

  it('can open on every page in the sidebar', () => {
    // main only accepts the pages in STARTUP_PAGES, so a new sidebar page has to be added there.
    expect(NAV_ITEMS.map((item) => item.to).filter((route) => !isStartupPage(route))).toEqual([]);
  });
});

describe('SettingsPage Docker containers when a run stops', () => {
  const TITLE = 'Docker containers when a run stops';

  it('asks by default, and sits with the other behavior rows', async () => {
    renderSettings();
    await screen.findByText(TITLE);

    const picker = within(card(TITLE)).getByRole('combobox', { name: TITLE });
    expect(picker).toHaveTextContent('Ask me');
    expect(card(TITLE)).toBe(card('Keep terminals running'));
  });

  it('shows the choice saved from the dialog', async () => {
    renderSettings({ 'settings.get': { ...settings, stopDockerWithRun: 'keep' } });
    await screen.findByText(TITLE);

    expect(screen.getByRole('combobox', { name: TITLE })).toHaveTextContent('Never stop them');
  });

  it.each([
    ['Always stop them', 'stop'],
    ['Never stop them', 'keep'],
    ['Ask me', 'ask'],
  ] as const)('saves %s', async (label, mode) => {
    const { user, bridge } = renderSettings({
      'settings.get': { ...settings, stopDockerWithRun: mode === 'ask' ? 'stop' : 'ask' },
    });
    await screen.findByText(TITLE);

    await user.click(screen.getByRole('combobox', { name: TITLE }));
    await user.click(await screen.findByRole('option', { name: label }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({ stopDockerWithRun: mode }),
    );
  });

  it.each(['docker', 'containers', 'compose'])('is found by searching for %s', async (query) => {
    const { user } = renderSettings();
    await screen.findByText(TITLE);

    await user.type(screen.getByLabelText('Search settings'), query);

    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    expect(screen.queryByText('Keep terminals running')).toBeNull();
  });
});

describe('SettingsPage idle Docker containers and emulators', () => {
  const TITLE = 'Idle Docker containers and emulators';
  const ALERTS = 'Idle resource alerts';
  const MINUTES = 'Minutes before a container or emulator counts as idle';

  it('shows 20 minutes by default, in the same card as the other behavior rows', async () => {
    renderSettings();
    await screen.findByText(TITLE);

    expect(screen.getByRole('spinbutton', { name: MINUTES })).toHaveValue(20);
    expect(card(TITLE)).toBe(card('Keep terminals running'));
  });

  it('shows the threshold saved earlier', async () => {
    renderSettings({ 'settings.get': { ...settings, idleResourceMinutes: 90 } });
    await screen.findByText(TITLE);

    await waitFor(() => expect(screen.getByRole('spinbutton', { name: MINUTES })).toHaveValue(90));
  });

  it('saves a new threshold when the box is left', async () => {
    const { user, bridge } = renderSettings();
    await screen.findByText(TITLE);

    const input = screen.getByRole('spinbutton', { name: MINUTES });
    await user.clear(input);
    await user.type(input, '45');
    await user.tab();

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({ idleResourceMinutes: 45 }),
    );
  });

  it.each([
    ['0', 1],
    ['99999', 1440],
  ])('clamps %s minutes to %s before saving', async (typed, saved) => {
    const { user, bridge } = renderSettings();
    await screen.findByText(TITLE);

    const input = screen.getByRole('spinbutton', { name: MINUTES });
    await user.clear(input);
    await user.type(input, `${typed}{Enter}`);

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({
        idleResourceMinutes: saved,
      }),
    );
  });

  it('saves nothing while the box is empty', async () => {
    const { user, bridge } = renderSettings();
    await screen.findByText(TITLE);

    const input = screen.getByRole('spinbutton', { name: MINUTES });
    await user.clear(input);
    await user.tab();

    expect(() => bridge.$fn('settings.update')).toThrow();
    expect(input).toHaveValue(20);
  });

  it('turns the alerts off and back on', async () => {
    const { user, bridge } = renderSettings();
    await screen.findByText(ALERTS);

    const toggle = screen.getByRole('switch', {
      name: 'Notify when a container or emulator goes idle',
    });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({ idleResourceNotify: false }),
    );
  });

  it.each(['idle', 'unused', 'emulator', 'android'])(
    'is found by searching for %s',
    async (query) => {
      const { user } = renderSettings();
      await screen.findByText(TITLE);

      await user.type(screen.getByLabelText('Search settings'), query);

      expect(await screen.findByText(TITLE)).toBeInTheDocument();
      expect(screen.queryByText('Keep terminals running')).toBeNull();
    },
  );
});

describe('SettingsPage search', () => {
  it('finds a setting that lives on another tab and says which category holds it', async () => {
    const { user } = renderSettings();
    await screen.findByText('Appearance');

    await user.type(screen.getByLabelText('Search settings'), 'backup');

    expect(await screen.findByText('Backup & restore')).toBeInTheDocument();
    expect(screen.queryByText('Appearance')).toBeNull();
    // Searching spans every tab, so no category reads as the open one; the counts say where
    // the matches are instead.
    const nav = categories();
    expect(within(nav).queryByRole('button', { current: 'page' })).toBeNull();
    expect(within(nav).getByRole('button', { name: 'Data, 1 match' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /^General$/ })).toBeInTheDocument();
  });

  it('keeps the search at the top of the category list instead of a row of its own', async () => {
    renderSettings();
    await screen.findByText('Appearance');

    const field = screen.getByLabelText('Search settings');
    const column = field.closest('aside');
    if (!column) throw new Error('The search field is not in the category column');
    expect(column).toContainElement(categories());
    // The field comes first, above the categories.
    expect(
      field.compareDocumentPosition(categories()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('filters as the user types and puts the open section back when cleared', async () => {
    const { user } = renderSettings({}, '/settings?tab=agents');
    await screen.findByText('Default CLI');
    const field = screen.getByLabelText('Search settings');

    await user.type(field, 'telegram');

    expect(await screen.findByText('Telegram bot')).toBeInTheDocument();
    expect(screen.queryByText('Default CLI')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Search results' })).toBeInTheDocument();

    // The little x inside the field, not the empty state's button.
    await user.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(await screen.findByText('Default CLI')).toBeInTheDocument();
    expect(screen.queryByText('Telegram bot')).toBeNull();
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    expect(within(categories()).getByRole('button', { name: /Agents/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('clears the search with Escape', async () => {
    const { user } = renderSettings();
    await screen.findByText('Appearance');
    const field = screen.getByLabelText('Search settings');

    await user.type(field, 'telegram');
    await screen.findByText('Telegram bot');
    await user.keyboard('{Escape}');

    expect(field).toHaveValue('');
    expect(await screen.findByText('Appearance')).toBeInTheDocument();
  });

  it('puts the cursor in the search on Ctrl+F', async () => {
    const { user } = renderSettings();
    await screen.findByText('Appearance');

    await user.keyboard('{Control>}f{/Control}');

    expect(screen.getByLabelText('Search settings')).toHaveFocus();
  });

  it('opens a category from the search and leaves the search behind', async () => {
    const { user } = renderSettings();
    await screen.findByText('Appearance');

    await user.type(screen.getByLabelText('Search settings'), 'backup');
    await user.click(within(categories()).getByRole('button', { name: /Notifications/ }));

    expect(await screen.findByText('Telegram bot')).toBeInTheDocument();
    expect(screen.queryByText('Backup & restore')).toBeNull();
    expect(screen.getByLabelText('Search settings')).toHaveValue('');
  });

  it('finds every card it shows, not only the ones on the first tabs', async () => {
    // These cards used to be missing from the match count, so a search for them claimed
    // nothing matched while the card was right there.
    const { user } = renderSettings();
    await screen.findByText('Appearance');
    const field = screen.getByLabelText('Search settings');

    await user.type(field, 'worktree');
    expect(await screen.findByText('Worktrees')).toBeInTheDocument();
    expect(screen.queryByText(/No settings match/)).toBeNull();

    await user.clear(field);
    await user.type(field, 'keep running');
    expect(await screen.findByText('Keep terminals running')).toBeInTheDocument();
    expect(screen.queryByText(/No settings match/)).toBeNull();
  });

  it('matches a section by a keyword that is not in its title', async () => {
    const { user } = renderSettings();
    await screen.findByText('Appearance');

    await user.type(screen.getByLabelText('Search settings'), 'telegram');

    expect(await screen.findByText('Telegram bot')).toBeInTheDocument();
    expect(screen.queryByText('Backup & restore')).toBeNull();
  });

  it('says nothing matched and offers a way back', async () => {
    const { user } = renderSettings();
    await screen.findByText('Appearance');
    const field = screen.getByLabelText('Search settings');

    await user.type(field, 'quantum tunnelling');

    expect(await screen.findByText(/No settings match/)).toBeInTheDocument();
    // The empty state's own button, not the little x inside the field.
    const clear = screen
      .getAllByRole('button', { name: 'Clear search' })
      .find((button) => button.textContent?.trim() === 'Clear search');
    if (!clear) throw new Error('The empty state has no Clear search button');
    await user.click(clear);

    expect(await screen.findByText('Appearance')).toBeInTheDocument();
    expect(field).toHaveValue('');
  });
});

describe('SettingsPage backup export', () => {
  it('exports with the switches as they were set and says where the file went', async () => {
    const { user, bridge } = renderSettings(
      { 'backup.export': async () => ({ ok: true, path: 'C:/backups/runova.json' }) },
      '/settings?tab=data',
    );
    await screen.findByText('Backup & restore');

    await user.click(screen.getByRole('switch', { name: /Compress as \.zip/ }));
    await user.click(screen.getByRole('button', { name: /Export backup/ }));

    await waitFor(() =>
      expect(bridge.$fn('backup.export')).toHaveBeenCalledWith(true, {
        environmentsPassword: undefined,
        includeVault: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Backup saved to C:/backups/runova.json');
  });

  it('leaves the Vault out when that switch is turned off', async () => {
    const { user, bridge } = renderSettings(
      { 'backup.export': async () => ({ ok: true, path: 'C:/backups/runova.json' }) },
      '/settings?tab=data',
    );
    await screen.findByText('Backup & restore');

    await user.click(screen.getByRole('switch', { name: /Include the Vault/ }));
    await user.click(screen.getByRole('button', { name: /Export backup/ }));

    await waitFor(() =>
      expect(bridge.$fn('backup.export')).toHaveBeenCalledWith(false, {
        environmentsPassword: undefined,
        includeVault: false,
      }),
    );
  });

  it('reports an export that failed instead of claiming a file was written', async () => {
    const { user } = renderSettings(
      { 'backup.export': async () => ({ ok: false, error: 'No space left on device' }) },
      '/settings?tab=data',
    );
    await screen.findByText('Backup & restore');

    await user.click(screen.getByRole('button', { name: /Export backup/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No space left on device'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('will not export environments behind a password too short to protect them', async () => {
    const { user, bridge } = renderSettings({}, '/settings?tab=data');
    await screen.findByText('Backup & restore');

    await user.click(screen.getByRole('switch', { name: /Include project environments/ }));
    // The password cannot be recovered, so an unusable one has to be caught before the export.
    expect(screen.getByRole('button', { name: /Export backup/ })).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Backup password'), 'short');

    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export backup/ })).toBeDisabled();
    expect(bridge.backup.export).not.toHaveBeenCalled();
  });

  it('will not export until the two password fields agree', async () => {
    const { user } = renderSettings({}, '/settings?tab=data');
    await screen.findByText('Backup & restore');
    await user.click(screen.getByRole('switch', { name: /Include project environments/ }));

    await user.type(screen.getByPlaceholderText('Backup password'), 'correct-horse');
    await user.type(screen.getByPlaceholderText('Confirm password'), 'correct-hose');

    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export backup/ })).toBeDisabled();
  });

  it('sends the password along once both fields agree', async () => {
    const { user, bridge } = renderSettings(
      { 'backup.export': async () => ({ ok: true, path: 'C:/backups/runova.json' }) },
      '/settings?tab=data',
    );
    await screen.findByText('Backup & restore');
    await user.click(screen.getByRole('switch', { name: /Include project environments/ }));

    await user.type(screen.getByPlaceholderText('Backup password'), 'correct-horse');
    await user.type(screen.getByPlaceholderText('Confirm password'), 'correct-horse');
    await user.click(screen.getByRole('button', { name: /Export backup/ }));

    await waitFor(() =>
      expect(bridge.$fn('backup.export')).toHaveBeenCalledWith(false, {
        environmentsPassword: 'correct-horse',
        includeVault: true,
      }),
    );
  });
});

describe('SettingsPage backup restore', () => {
  it('warns before replacing everything and then opens a file', async () => {
    const { user, bridge } = renderSettings(
      {
        'backup.open': async () => ({ ok: true, token: 'tok-1', vault: false }),
        'backup.restore': async () => ({ ok: true, warnings: [] }),
      },
      '/settings?tab=data',
    );
    await screen.findByText('Backup & restore');

    await user.click(screen.getByRole('button', { name: /Restore from backup…/ }));

    expect(confirm.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Restore from backup?', variant: 'destructive' }),
    );
    await waitFor(() => expect(bridge.$fn('backup.open')).toHaveBeenCalled());
    await waitFor(() =>
      expect(bridge.$fn('backup.restore')).toHaveBeenCalledWith('tok-1', {
        environmentsPassword: null,
        restoreVault: false,
      }),
    );
  });

  it('opens nothing when the warning is dismissed', async () => {
    confirm.confirmDialog.mockResolvedValueOnce(false);
    const { user, bridge } = renderSettings({}, '/settings?tab=data');
    await screen.findByText('Backup & restore');

    await user.click(screen.getByRole('button', { name: /Restore from backup…/ }));

    await waitFor(() => expect(confirm.confirmDialog).toHaveBeenCalled());
    expect(bridge.backup.open).not.toHaveBeenCalled();
  });

  it('says why a backup file could not be opened', async () => {
    const { user, bridge } = renderSettings(
      {
        'backup.open': async () => ({ ok: false, error: 'That file is not a Runova backup.' }),
      },
      '/settings?tab=data',
    );
    await screen.findByText('Backup & restore');

    await user.click(screen.getByRole('button', { name: /Restore from backup…/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That file is not a Runova backup.'),
    );
    expect(bridge.backup.restore).not.toHaveBeenCalled();
  });

  it('asks for the export password when the backup carries environments', async () => {
    const { user, bridge } = renderSettings(
      {
        'backup.open': async () => ({
          ok: true,
          token: 'tok-1',
          vault: false,
          environments: { count: 3 },
        }),
        'backup.restore': async () => ({ wrongPassword: true }),
      },
      '/settings?tab=data',
    );
    await screen.findByText('Backup & restore');

    await user.click(screen.getByRole('button', { name: /Restore from backup…/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/3 project environments/)).toBeInTheDocument();
    // Restoring with no password at all would silently drop the environments.
    expect(within(dialog).getByRole('button', { name: /^Restore$/ })).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Password'), 'wrong-one');
    await user.click(within(dialog).getByRole('button', { name: /^Restore$/ }));

    expect(
      await within(dialog).findByText('That password does not open this backup.'),
    ).toBeInTheDocument();
    expect(bridge.$fn('backup.restore')).toHaveBeenCalledWith('tok-1', {
      environmentsPassword: 'wrong-one',
      restoreVault: false,
    });
  });

  it('can restore everything except the environments', async () => {
    const { user, bridge } = renderSettings(
      {
        'backup.open': async () => ({
          ok: true,
          token: 'tok-1',
          vault: false,
          environments: { count: 1 },
        }),
        'backup.restore': async () => ({ ok: true, warnings: ['One project could not be read.'] }),
      },
      '/settings?tab=data',
    );
    await screen.findByText('Backup & restore');
    await user.click(screen.getByRole('button', { name: /Restore from backup…/ }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: /Restore without them/ }));

    await waitFor(() =>
      expect(bridge.$fn('backup.restore')).toHaveBeenCalledWith('tok-1', {
        environmentsPassword: null,
        restoreVault: false,
      }),
    );
    // Anything the restore could not read has to be said out loud, not swallowed.
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('One project could not be read.'),
    );
    await waitFor(() =>
      expect(confirm.confirmDialog).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: 'Backup restored' }),
      ),
    );
    expect(bridge.$fn('app.relaunch')).toHaveBeenCalled();
  });

  it('asks whether the backup’s Vault should replace this machine’s', async () => {
    const { user, bridge } = renderSettings(
      {
        'backup.open': async () => ({ ok: true, token: 'tok-1', vault: true }),
        'backup.restore': async () => ({ ok: true, warnings: [] }),
      },
      '/settings?tab=data',
    );
    await screen.findByText('Backup & restore');

    await user.click(screen.getByRole('button', { name: /Restore from backup…/ }));

    await waitFor(() =>
      expect(confirm.confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Restore the Vault too?' }),
      ),
    );
    await waitFor(() =>
      expect(bridge.$fn('backup.restore')).toHaveBeenCalledWith('tok-1', {
        environmentsPassword: null,
        restoreVault: true,
      }),
    );
  });
});

describe('SettingsPage voice input', () => {
  const AI = '/settings?tab=ai';

  it('has no auto-detect, which the local model would quietly read as English', async () => {
    const { user } = renderSettings({}, AI);
    await screen.findByText('Voice input');

    const picker = screen.getByRole('combobox', { name: 'Spoken language' });
    // An old "auto" setting shows as the language it really means.
    expect(picker).not.toHaveTextContent('Auto');
    await user.click(picker);

    expect(await screen.findByRole('option', { name: 'English' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Auto/ })).toBeNull();
  });

  it('saves Persian when it is picked', async () => {
    const { user, bridge } = renderSettings(
      { 'settings.get': { ...settings, speechLanguage: 'en', speechModel: 'large-v3-turbo' } },
      AI,
    );
    await screen.findByText('Voice input');

    await user.click(screen.getByRole('combobox', { name: 'Spoken language' }));
    await user.click(await screen.findByRole('option', { name: 'Persian (فارسی)' }));
    await user.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        speechModel: 'large-v3-turbo',
        speechLanguage: 'fa',
      }),
    );
  });

  it('says the small model gets Persian wrong and switches to the large one', async () => {
    const { user, bridge } = renderSettings(
      { 'settings.get': { ...settings, speechLanguage: 'fa', speechModel: 'base' } },
      AI,
    );
    await screen.findByText('Voice input');

    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('This model often gets Persian (فارسی) wrong.');
    await user.click(within(note).getByRole('button', { name: 'Use this model' }));

    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Speech model' })).toHaveTextContent(
      'Large v3 Turbo',
    );
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
        speechModel: 'large-v3-turbo',
        speechLanguage: 'fa',
      }),
    );
  });

  it('does not warn for English on the default model', async () => {
    renderSettings({ 'settings.get': { ...settings, speechLanguage: 'en' } }, AI);
    await screen.findByText('Voice input');

    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('SettingsPage unsaved changes', () => {
  it('holds an edited projects folder back until it is saved', async () => {
    const { user, bridge } = renderSettings();
    await screen.findByText('Projects folder');

    await user.type(within(card('Projects folder')).getByRole('textbox'), 'C:/Work');

    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    expect(bridge.settings.update).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ projectsRootPath: 'C:/Work' }),
    );
    expect(toast.success).toHaveBeenCalledWith('Projects folder saved.');
  });

  it('drops the edit when it is discarded', async () => {
    const { user, bridge } = renderSettings();
    await screen.findByText('Projects folder');
    await user.type(within(card('Projects folder')).getByRole('textbox'), 'C:/Work');
    await screen.findByText('Unsaved changes');

    await user.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    expect(bridge.settings.update).not.toHaveBeenCalled();
  });

  it('draws the save bar as pills, with Save as the primary one and Discard as a soft one', async () => {
    const { user } = renderSettings();
    await screen.findByText('Projects folder');
    await user.type(within(card('Projects folder')).getByRole('textbox'), 'C:/Work');
    await screen.findByText('Unsaved changes');

    const save = screen.getByRole('button', { name: /Save changes/ });
    const discard = screen.getByRole('button', { name: 'Discard' });
    expect(save).toHaveClass('rounded-full', 'bg-primary');
    expect(discard).toHaveClass('rounded-full', 'search-pill');
    expect(discard).not.toHaveClass('bg-primary');
  });
});

describe('SettingsPage help search', () => {
  it('is found by searching for embedding', async () => {
    const { user } = renderSettings();
    await screen.findByText('Appearance');

    await user.type(screen.getByLabelText('Search settings'), 'embedding');

    expect(await screen.findByText('Help search')).toBeInTheDocument();
    expect(screen.queryByText('Appearance')).toBeNull();
  });
});

describe('SettingsPage Build Prompt sizing', () => {
  const sizingSwitch = 'Size right after Generate or Translate';

  it('is on for a profile that never saved the switch', async () => {
    const { user } = renderSettings();

    await user.type(screen.getByLabelText('Search settings'), 'build prompt sizing');

    expect(await screen.findByRole('switch', { name: sizingSwitch })).toBeChecked();
  });

  it('shows a switch that was saved off as off', async () => {
    const { user } = renderSettings({
      'settings.get': { ...settings, promptBuilderAutoSize: false },
    });

    await user.type(screen.getByLabelText('Search settings'), 'build prompt sizing');

    expect(await screen.findByRole('switch', { name: sizingSwitch })).not.toBeChecked();
  });

  it('saves a click on the switch straight away, without a save bar', async () => {
    const { user, bridge } = renderSettings({
      'settings.get': { ...settings, promptBuilderAutoSize: true },
    });
    await user.type(screen.getByLabelText('Search settings'), 'build prompt sizing');

    await user.click(await screen.findByRole('switch', { name: sizingSwitch }));

    await waitFor(() =>
      expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ promptBuilderAutoSize: false }),
    );
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('is found by searching for the modal it controls', async () => {
    const { user } = renderSettings();

    await user.type(screen.getByLabelText('Search settings'), 'modal');

    expect(await screen.findByText('Build Prompt sizing')).toBeInTheDocument();
  });
});
