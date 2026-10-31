import type {
  AiProvider,
  AppSettings,
  MenuPosition,
  PingIpVersion,
  PingMethod,
  RunDockerStopMode,
  StartupPage,
  ThemeMode,
} from '@runova/core';
import {
  CLI_REGISTRY,
  DEFAULT_GEMINI_API_MODEL,
  DEFAULT_OPENAI_API_MODEL,
  DEFAULT_WHISPER_MODEL,
  isPipelineFailureOpen,
  isRunDockerStopMode,
  isStartupPage,
  resolveSpeechLanguage,
  SPEECH_LANGUAGES,
  speechModelTooSmallFor,
  WHISPER_MODELS,
} from '@runova/core';
import type { OllamaConnectionTest } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CliArgsField } from '@/components/CliArgsField';
import { cliOptionIcon } from '@/components/cliLogos';
import { IdleMinutesInput } from '@/components/dashboard/IdleMinutesInput';
import {
  Bell,
  Blocks,
  CircleQuestion,
  Clapperboard,
  Clock,
  Code,
  Docker,
  Download,
  FolderOpen,
  GitBranch,
  GitCommit,
  GitPullRequest,
  HardDrive,
  History,
  Keyboard,
  Languages,
  MessageSquare,
  Microphone,
  Monitor,
  Moon,
  NetworkIcon,
  Pause,
  Paw,
  Play,
  Power,
  RefreshCw,
  Robot,
  Route,
  Save,
  Search,
  SettingsIcon,
  Sun,
  TerminalSquare,
  TriangleAlert,
  Upload,
  Vault,
  VsInfinity,
  X,
} from '@/components/icons';
import { NAV_ITEMS } from '@/components/layout/Sidebar';
import { SECTION_HEADING } from '@/components/pageKit';
import { CompanionSettings } from '@/components/pet/CompanionSettings';
import { AgentTabViewSettings } from '@/components/settings/AgentTabViewSettings';
import { AndroidSdkSettings } from '@/components/settings/AndroidSdkSettings';
import { BackupEnvironmentsPasswordDialog } from '@/components/settings/BackupEnvironmentsPasswordDialog';
import { BlueprintPresetSettings } from '@/components/settings/BlueprintPresetSettings';
import { CiAutoFixSettings } from '@/components/settings/CiAutoFixSettings';
import { CliLaunchDefaultsSettings } from '@/components/settings/CliLaunchDefaultsSettings';
import { CliOrderSettings } from '@/components/settings/CliOrderSettings';
import { CommitMessageSettingsForm } from '@/components/settings/CommitMessageSettingsCard';
import { HelpSearchSettings } from '@/components/settings/HelpSearchSettings';
import { NewsSettings } from '@/components/settings/NewsSettings';
import { ProxySettings } from '@/components/settings/ProxySettings';
import { ReviewCommandsSettings } from '@/components/settings/ReviewCommandsSettings';
import { ShortcutSettings } from '@/components/settings/ShortcutSettings';
import { StatusBarUsageSettings } from '@/components/settings/StatusBarUsageSettings';
import { WorktreeSettingsForm } from '@/components/settings/WorktreeSettings';
import { WritingCheckSettings } from '@/components/settings/WritingCheckSettings';
import { StudioSettingsSection } from '@/components/studio/settings/StudioSettingsSection';
import { formatUpdateBytes, UpdateProgressTrack, updatePercent } from '@/components/UpdateManager';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { COLOR_FIELD, Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { MULTILINE_FIELD_RADIUS } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { VaultSettings } from '@/components/vault/VaultSettings';
import { useIdleResourceSettings } from '@/hooks/useIdleResourceSettings';
import { queryKeys } from '@/lib/queryKeys';
import { isShortcutLetter } from '@/lib/shortcutKey';
import { cn } from '@/lib/utils';
import { useCliStore } from '@/stores/cliStore';
import { confirmDialog } from '@/stores/confirmStore';
import { usePageHeader } from '@/stores/pageHeaderStore';
import {
  DEFAULT_PING_TARGETS_IPV4,
  DEFAULT_PING_TARGETS_IPV6,
  DEFAULT_PING_URL,
  MAX_PING_URL_INTERVAL_SECONDS,
  MIN_PING_URL_INTERVAL_SECONDS,
  usePingTargetsStore,
} from '@/stores/pingTargetsStore';
import { useTerminalAppearanceStore } from '@/stores/terminalAppearanceStore';
import { type ResolvedTheme, themeClassName, useThemeStore } from '@/stores/themeStore';
import { openUpdateDialog, useUpdateStore } from '@/stores/updateStore';

const PROMPT_BUILDER_PROVIDER_OPTIONS: { value: AiProvider; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'ollama', label: 'Ollama' },
];

// No auto-detect: the local Whisper runtime cannot detect a language and quietly assumes English.
const SPEECH_LANGUAGE_OPTIONS = SPEECH_LANGUAGES.map((lang) => ({
  value: lang.code,
  label: lang.label,
}));

const THEME_OPTIONS: { value: ThemeMode; label: string; hint: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', hint: 'Bright canvas', icon: Sun },
  { value: 'dark', label: 'Dark', hint: 'Near-black canvas', icon: Moon },
  { value: 'system', label: 'System', hint: 'Follow this machine', icon: Monitor },
  { value: 'vscode-dark', label: 'VS Code Dark', hint: 'Blue accent, editor-inspired', icon: Code },
  { value: 'vs2026', label: 'VS 2026', hint: 'Violet accent, modern IDE', icon: VsInfinity },
];

const MENU_POSITION_OPTIONS: { value: MenuPosition; label: string; hint: string }[] = [
  { value: 'left', label: 'Left', hint: 'A sidebar down the left edge' },
  { value: 'top', label: 'Top', hint: 'A menu bar under the title bar' },
];

const STARTUP_PAGE_KEYWORDS =
  'startup start launch open opening page restore reopen last left off dashboard home';

/** "Last opened page" first, then every sidebar page main can open on. */
const STARTUP_PAGE_OPTIONS: ComboboxOption[] = [
  { value: 'last', label: 'Last opened page', icon: <History className="h-3.5 w-3.5" /> },
  ...NAV_ITEMS.filter((item) => isStartupPage(item.to)).map((item) => ({
    value: item.to,
    label: item.label,
    icon: <item.icon className="h-3.5 w-3.5" />,
  })),
];

const RUN_DOCKER_STOP_OPTIONS: ComboboxOption[] = [
  { value: 'ask', label: 'Ask me' },
  { value: 'stop', label: 'Always stop them' },
  { value: 'keep', label: 'Never stop them' },
];

const SETTINGS_TABS = [
  'general',
  'agents',
  'shortcuts',
  'companion',
  'ai',
  'notifications',
  'network',
  'vault',
  'data',
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

function isSettingsTab(value: string | null): value is SettingsTab {
  return SETTINGS_TABS.includes(value as SettingsTab);
}

const LAUNCH_DEFAULTS_KEYWORDS =
  'launch defaults default model effort reasoning permission mode auto mode plan accept edits bypass yolo full access sandbox approval open cli start';

const BLUEPRINT_PRESET_KEYWORDS =
  'blueprint preset presets snippet snippets default defaults wizard steps idea architecture stack backend frontend ci cd pipeline quality testing product manager phases epics docs';

const PIPELINE_FAILURE_KEYWORDS =
  'pipeline pipelines failure failed fails error github actions ci build run notification toast message pet bubble open click inbox unread badge workspace git panel project page';

const PIPELINE_FAILURE_OPEN_OPTIONS: ComboboxOption[] = [
  {
    value: 'workspace',
    label: 'Project workspace',
    icon: <GitBranch className="h-3.5 w-3.5" />,
  },
  { value: 'pipelines', label: 'Pipelines page', icon: <Route className="h-3.5 w-3.5" /> },
  { value: 'none', label: 'Just dismiss it', icon: <X className="h-3.5 w-3.5" /> },
];

const VAULT_KEYWORDS =
  'vault password passwords manager credentials auto-lock lock idle clipboard clear master password reset sleep';

const PROXY_KEYWORDS =
  'proxy http proxy https proxy socks socks5 socks4 system proxy vpn bypass no_proxy corporate firewall connection internet network offline pac auth username password port host';

const TAB_META: {
  id: SettingsTab;
  label: string;
  /** One line under the section title saying what lives there. */
  description: string;
  icon: typeof SettingsIcon;
  keywords: string;
}[] = [
  {
    id: 'general',
    label: 'General',
    description: 'How Runova looks, where it opens and the everyday defaults for this machine.',
    icon: SettingsIcon,
    keywords: 'appearance theme terminal sessions projects folder skills blueprint presets',
  },
  {
    id: 'agents',
    label: 'Agents',
    description: 'Which CLI starts, how each one launches, and how agents work with git.',
    icon: Robot,
    keywords:
      'default cli agent order arrange launcher tiles number keys commit message written by style conventional instructions git claude codex model effort permission mode auto yolo',
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    description: 'Keys for the app, the Workspace and the commit box.',
    icon: Keyboard,
    keywords:
      'keyboard shortcut shortcuts keybinding hotkey ctrl cmd alt terminal projects palette',
  },
  {
    id: 'companion',
    label: 'AI Pet',
    description: 'The desktop companion that keeps an eye on your pipelines and the connection.',
    icon: Paw,
    keywords:
      'pet ai pet my ai pet companion desktop character walk mascot climb rope size click area tight wander gif png webp custom add pipeline github actions fail pass notify internet quality ping offline',
  },
  {
    id: 'ai',
    label: 'AI',
    description: 'API keys, local models, voice input and writing checks.',
    icon: MessageSquare,
    keywords:
      'openai gemini ollama api key whisper voice translate writing grammar spelling style languagetool context length num_ctx keep alive test connection local model',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Where Runova reaches you when a pipeline fails or you are away from the app.',
    icon: Bell,
    keywords: `telegram bot chat notify ${PIPELINE_FAILURE_KEYWORDS}`,
  },
  {
    id: 'network',
    label: 'Network',
    description: 'How Runova reaches the internet and how connection quality is measured.',
    icon: NetworkIcon,
    keywords: PROXY_KEYWORDS,
  },
  {
    id: 'vault',
    label: 'Vault',
    description: 'When the Vault locks itself and how long copied secrets stay on the clipboard.',
    icon: Vault,
    keywords: VAULT_KEYWORDS,
  },
  {
    id: 'data',
    label: 'Data',
    description: 'Back up or restore everything on this machine, and keep Runova up to date.',
    icon: HardDrive,
    keywords: 'backup restore ping network about version update',
  },
];

const WRITING_CHECK_KEYWORDS =
  'writing grammar grammarly spelling spellcheck spell check style languagetool language tool proofread punctuation local server offline java tools folder mother tongue picky rules';

const SHORTCUT_KEYWORDS =
  'keyboard shortcut shortcuts keybinding hotkey ctrl cmd alt terminal projects command palette layout language workspace pane split tab diff commit push';

function matchesQuery(query: string, ...parts: Array<string | undefined>): boolean {
  if (!query) return true;
  return parts.some((part) => part?.toLowerCase().includes(query));
}

/**
 * Every card the page can show, with the tab it lives on and the words search finds it by.
 * The cards and the search counts both read this one list, so a card can't match a search
 * while the page claims nothing did.
 */
const SECTIONS = {
  appearance: {
    tab: 'general',
    title: 'Appearance',
    keywords:
      'appearance theme dark light system vscode visual studio vs2026 code look main menu sidebar top bar menu bar navigation position layout',
  },
  statusBarUsage: {
    tab: 'general',
    title: 'Status bar limits',
    keywords:
      'status bar bottom limits usage quota plan session weekly reset countdown claude code codex cursor',
  },
  startupPage: { tab: 'general', title: 'Startup page', keywords: STARTUP_PAGE_KEYWORDS },
  keepTerminals: {
    tab: 'general',
    title: 'Keep terminals running',
    keywords: 'terminal shell sessions keep running background quit close exit restart update',
  },
  stopDockerWithRun: {
    tab: 'general',
    title: 'Docker containers when a run stops',
    keywords:
      'docker containers compose stop run project resources memory cpu ask always never keep running',
  },
  idleResources: {
    tab: 'general',
    title: 'Idle Docker containers and emulators',
    keywords:
      'idle unused docker containers emulator android dashboard minutes threshold time stop resources memory cpu free',
  },
  idleResourceNotify: {
    tab: 'general',
    title: 'Idle resource alerts',
    keywords:
      'idle unused docker containers emulator android notification alert notify dashboard stop',
  },
  workspaceNotifications: {
    tab: 'general',
    title: 'Workspace notifications',
    keywords: 'workspace agent notifications finished done question input alert claude codex',
  },
  terminalAiNotifications: {
    tab: 'general',
    title: 'Terminal AI notifications',
    keywords: 'terminal ai task notifications question approval approve command ssh waiting alert',
  },
  toolUpdates: {
    tab: 'general',
    title: 'Check for CLI and tool updates',
    keywords: 'cli tool update check automatic daily notification bell version',
  },
  terminalBackground: {
    tab: 'general',
    title: 'Workspace terminal background',
    keywords:
      'workspace terminal background color cli claude code codex gray custom theme foreground contrast',
  },
  projectsFolder: {
    tab: 'general',
    title: 'Projects folder',
    keywords: 'projects folder path directory',
  },
  skillRepositories: {
    tab: 'general',
    title: 'Skill repositories',
    keywords: 'skills repositories sources',
  },
  blueprintPresets: {
    tab: 'general',
    title: 'Blueprint presets',
    keywords: BLUEPRINT_PRESET_KEYWORDS,
  },
  androidSdk: {
    tab: 'general',
    title: 'Android SDK',
    keywords: 'android sdk adb emulator avd avdmanager sdkmanager platform-tools path',
  },
  defaultCli: {
    tab: 'agents',
    title: 'Default CLI',
    keywords: 'default cli provider agent arguments args flags model',
  },
  launchDefaults: { tab: 'agents', title: 'Launch defaults', keywords: LAUNCH_DEFAULTS_KEYWORDS },
  agentTabView: {
    tab: 'agents',
    title: 'Default view for agent tabs',
    keywords: 'chat view cli view mode default tab conversation workspace agent messages bubbles',
  },
  agentOrder: {
    tab: 'agents',
    title: 'Agent order',
    keywords: 'agent cli order sort arrange workspace launcher tiles number keys',
  },
  commitMessages: {
    tab: 'agents',
    title: 'Commit messages',
    keywords: 'commit message ai generate style conventional instructions git workspace',
  },
  worktrees: {
    tab: 'agents',
    title: 'Worktrees',
    keywords: 'worktree worktrees git branch parallel folder env copy setup location',
  },
  studio: {
    tab: 'agents',
    title: 'Studio',
    keywords:
      'studio video videos library folder storage location cache render resume gpu encode voice narration elevenlabs azure speech key region',
  },
  reviewCommands: {
    tab: 'agents',
    title: 'Review commands',
    keywords:
      'pull request review command bot claude gemini coderabbit codex comment github workspace',
  },
  shortcuts: { tab: 'shortcuts', title: 'Keyboard shortcuts', keywords: SHORTCUT_KEYWORDS },
  companion: {
    tab: 'companion',
    title: 'My AI Pet',
    keywords:
      'pet ai pet my ai pet companion desktop character walk mascot climb rope size click area tight wander pipeline github actions fail pass internet quality',
  },
  providers: {
    tab: 'ai',
    title: 'Providers',
    keywords:
      'openai gemini ollama api key model prompt builder provider context length num_ctx keep alive test connection',
  },
  voiceInput: {
    tab: 'ai',
    title: 'Voice input',
    keywords: 'voice whisper speech microphone transcription',
  },
  helpSearch: {
    tab: 'ai',
    title: 'Help search',
    keywords:
      'help guide ask the guide rag embedding embeddings model vector search index reindex rebuild sqlite-vec nomic bge multilingual',
  },
  writingCheck: { tab: 'ai', title: 'Writing check', keywords: WRITING_CHECK_KEYWORDS },
  translationRetries: {
    tab: 'ai',
    title: 'Translation retries',
    keywords: 'translation retries translate',
  },
  buildPromptSizing: {
    tab: 'ai',
    title: 'Build Prompt sizing',
    keywords:
      'build prompt modal dialog size sizing sized auto automatic recommended run model effort generate translate chip cost',
  },
  pipelineFailures: {
    tab: 'notifications',
    title: 'Pipeline failures',
    keywords: PIPELINE_FAILURE_KEYWORDS,
  },
  news: {
    tab: 'notifications',
    title: 'News',
    keywords:
      'news dashboard runovahq security fix fixes vulnerability cve severity critical high category categories notify notification privacy affects your system',
  },
  ciAutoFix: {
    tab: 'notifications',
    title: 'CI auto-fix',
    keywords:
      'ci cd auto fix autofix pipeline github actions workflow failure agent cli commit push repair tries attempts model effort',
  },
  telegram: {
    tab: 'notifications',
    title: 'Telegram bot',
    keywords: 'telegram bot token chat notify',
  },
  proxy: { tab: 'network', title: 'Proxy', keywords: PROXY_KEYWORDS },
  pingTargets: {
    tab: 'network',
    title: 'Network ping targets',
    keywords: 'ping network hosts dashboard url http generate_204 icmp status bar ipv4 ipv6',
  },
  vault: { tab: 'vault', title: 'Vault', keywords: VAULT_KEYWORDS },
  backup: {
    tab: 'data',
    title: 'Backup & restore',
    keywords: 'backup restore export import zip environments secrets password vault',
  },
  about: { tab: 'data', title: 'About', keywords: 'about version update check' },
} as const satisfies Record<string, { tab: SettingsTab; title: string; keywords: string }>;

type SectionId = keyof typeof SECTIONS;

const SECTION_IDS = Object.keys(SECTIONS) as SectionId[];

/** The settings that share one card of rows at the top of General. */
const BEHAVIOR_SECTIONS: SectionId[] = [
  'startupPage',
  'keepTerminals',
  'stopDockerWithRun',
  'idleResources',
  'idleResourceNotify',
  'workspaceNotifications',
  'terminalAiNotifications',
  'toolUpdates',
  'terminalBackground',
];

function sectionMatches(id: SectionId, query: string): boolean {
  const section = SECTIONS[id];
  return matchesQuery(
    query,
    section.title,
    section.keywords,
    TAB_META.find((item) => item.id === section.tab)?.label,
  );
}

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
}

function findShortcutLabel(): string {
  return isMacPlatform() ? '⌘F' : 'Ctrl+F';
}

function saveShortcutLabel(): string {
  return isMacPlatform() ? '⌘S' : 'Ctrl+S';
}

function ExternalLinkButton({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="underline underline-offset-2 hover:text-foreground"
      onClick={() => void window.runova.shell.openExternal(href)}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function SettingsCard({
  icon: Icon,
  title,
  description,
  action,
  dirty,
  children,
}: {
  icon: typeof Sun;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  dirty?: boolean;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <Card className={cn('glass', dirty && 'ring-1 ring-primary/35')}>
      <CardHeader className={cn('flex-row items-start justify-between gap-4', !children && 'pb-5')}>
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{title}</CardTitle>
              {dirty ? (
                <Badge variant="warning" className="font-normal">
                  Unsaved
                </Badge>
              ) : null}
            </div>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </CardHeader>
      {children ? <CardContent>{children}</CardContent> : null}
    </Card>
  );
}

/**
 * One line of a grouped card: what the setting does on the left, its control on the right
 * edge, and anything the control reveals underneath.
 */
function SettingsRow({
  icon: Icon,
  title,
  description,
  control,
  children,
}: {
  icon: typeof Sun;
  title: string;
  description?: ReactNode;
  control: ReactNode;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="relative px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-[min(100%,16rem)] flex-1 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold leading-none">{title}</h3>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">{control}</div>
      </div>
      {children ? <div className="mt-3 pl-12">{children}</div> : null}
    </div>
  );
}

function ThemePreview({ mode }: { mode: ThemeMode }): React.JSX.Element {
  if (mode === 'system') {
    return (
      <div className="flex h-16 overflow-hidden rounded-md border border-border">
        <MiniWindow
          resolved="light"
          className="w-1/2 rounded-none border-0 border-r border-black/10"
        />
        <MiniWindow resolved="dark" className="w-1/2 rounded-none border-0" />
      </div>
    );
  }
  return <MiniWindow resolved={mode} className="h-16" />;
}

/** Renders with the exact classes that theme applies to `<html>`, so its swatches read
 * from the real CSS variables instead of a hand-picked, driftable copy of them. */
function MiniWindow({
  resolved,
  className,
}: {
  resolved: ResolvedTheme;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex overflow-hidden rounded-md border border-border bg-background',
        // Light is the default and has no class on <html>, so inside a dark window the light
        // preview needs its own to reset the colours, or it inherits the dark ones.
        resolved === 'light' ? 'theme-light' : themeClassName(resolved),
        className,
      )}
    >
      <div className="w-5 shrink-0 bg-card" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-1.5">
        <div className="h-1.5 w-7 rounded-full bg-foreground/25" />
        <div className="h-1.5 w-10 rounded-full bg-primary" />
        <div className="mt-0.5 min-h-0 flex-1 rounded-sm bg-foreground/8" />
      </div>
    </div>
  );
}

/** A sketch of the window with the main menu where that option puts it. */
function MenuPositionPreview({ position }: { position: MenuPosition }): React.JSX.Element {
  const content = (
    <div className="flex min-w-0 flex-1 flex-col gap-1 p-1.5">
      <div className="h-1.5 w-7 rounded-full bg-foreground/25" />
      <div className="mt-0.5 min-h-0 flex-1 rounded-sm bg-foreground/8" />
    </div>
  );
  if (position === 'left') {
    return (
      <div className="flex h-16 overflow-hidden rounded-md border border-border bg-background">
        <div className="flex w-6 shrink-0 flex-col gap-1 bg-card p-1">
          <div className="h-1.5 rounded-full bg-primary" />
          <div className="h-1.5 rounded-full bg-foreground/20" />
          <div className="h-1.5 rounded-full bg-foreground/20" />
        </div>
        {content}
      </div>
    );
  }
  return (
    <div className="flex h-16 flex-col overflow-hidden rounded-md border border-border bg-background">
      <div className="flex shrink-0 items-center gap-1 bg-card px-1.5 py-1">
        <div className="h-1.5 w-5 rounded-full bg-primary" />
        <div className="h-1.5 w-4 rounded-full bg-foreground/20" />
        <div className="h-1.5 w-4 rounded-full bg-foreground/20" />
        <div className="h-1.5 w-4 rounded-full bg-foreground/20" />
      </div>
      {content}
    </div>
  );
}

const PING_IP_OPTIONS: { value: PingIpVersion; label: string; hint: string }[] = [
  { value: 'ipv4', label: 'IPv4', hint: 'Pings IPv4 addresses such as 1.1.1.1.' },
  { value: 'ipv6', label: 'IPv6', hint: 'Pings IPv6 addresses. Use this on IPv6-only networks.' },
];

const PING_METHOD_OPTIONS: { value: PingMethod; label: string; hint: string }[] = [
  {
    value: 'icmp',
    label: 'Ping command',
    hint: 'Uses the system ping. Fails where ICMP is blocked.',
  },
  {
    value: 'http',
    label: 'URL request',
    hint: 'Times an HTTPS request. Works behind most firewalls.',
  },
  { value: 'auto', label: 'Auto', hint: 'Ping first, switch to URLs if nothing answers.' },
];

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function HostChips({
  value,
  onChange,
  placeholder = '1.1.1.1',
  validate,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Returns false for an entry that should be refused. */
  validate?: (entry: string) => boolean;
  ariaLabel?: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const hosts = useMemo(
    () =>
      Array.from(
        new Set(
          value
            .split(',')
            .map((host) => host.trim())
            .filter(Boolean),
        ),
      ),
    [value],
  );

  function commit(raw: string): void {
    const next = raw.trim();
    if (!next || hosts.includes(next)) {
      setDraft('');
      return;
    }
    if (validate && !validate(next)) {
      toast.error(`"${next}" is not a valid entry.`);
      return;
    }
    onChange([...hosts, next].join(', '));
    setDraft('');
  }

  function remove(host: string): void {
    onChange(hosts.filter((item) => item !== host).join(', '));
  }

  return (
    // The multi-line corner reads as a pill on one line and a rounded box once the chips wrap.
    <div
      className={cn(
        'field-surface flex min-h-9 flex-wrap items-center gap-1.5 py-1.5 pl-2 pr-3',
        MULTILINE_FIELD_RADIUS,
      )}
    >
      {hosts.map((host) => (
        <span
          key={host}
          className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.07] py-0.5 pl-2.5 pr-1 font-mono text-xs"
        >
          {host}
          <button
            type="button"
            className="cursor-pointer rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            aria-label={`Remove ${host}`}
            onClick={() => remove(host)}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            commit(draft);
          } else if (event.key === 'Backspace' && !draft && hosts.length > 0) {
            remove(hosts[hosts.length - 1]);
          }
        }}
        onBlur={() => commit(draft)}
        aria-label={ariaLabel}
        placeholder={hosts.length === 0 ? placeholder : 'Add another'}
        className="min-w-[8rem] flex-1 bg-transparent pl-1 text-sm outline-none"
      />
    </div>
  );
}

export default function SettingsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const defaultCliId = useCliStore((s) => s.defaultCliId);
  const setDefaultCliId = useCliStore((s) => s.setDefaultCliId);
  const terminalCustomBackground = useTerminalAppearanceStore((s) => s.customBackground);
  const setTerminalCustomBackground = useTerminalAppearanceStore((s) => s.setCustomBackground);
  const terminalBackgroundColor = useTerminalAppearanceStore((s) => s.backgroundColor);
  const setTerminalBackgroundColor = useTerminalAppearanceStore((s) => s.setBackgroundColor);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const pingTargets = usePingTargetsStore((s) => s.pingTargets);
  const setPingTargets = usePingTargetsStore((s) => s.setPingTargets);
  const pingIpVersion = usePingTargetsStore((s) => s.pingIpVersion);
  const setPingIpVersion = usePingTargetsStore((s) => s.setPingIpVersion);
  const pingTargetsIpv6 = usePingTargetsStore((s) => s.pingTargetsIpv6);
  const setPingTargetsIpv6 = usePingTargetsStore((s) => s.setPingTargetsIpv6);
  const pingMethod = usePingTargetsStore((s) => s.pingMethod);
  const setPingMethod = usePingTargetsStore((s) => s.setPingMethod);
  const pingUrls = usePingTargetsStore((s) => s.pingUrls);
  const setPingUrls = usePingTargetsStore((s) => s.setPingUrls);
  const pingUrlIntervalSeconds = usePingTargetsStore((s) => s.pingUrlIntervalSeconds);
  const setPingUrlIntervalSeconds = usePingTargetsStore((s) => s.setPingUrlIntervalSeconds);
  const [pingIntervalDraft, setPingIntervalDraft] = useState<string | null>(null);

  function commitPingInterval(): void {
    if (pingIntervalDraft === null) return;
    const parsed = Number.parseInt(pingIntervalDraft, 10);
    setPingIntervalDraft(null);
    if (!Number.isFinite(parsed)) return;
    setPingUrlIntervalSeconds(
      Math.min(MAX_PING_URL_INTERVAL_SECONDS, Math.max(MIN_PING_URL_INTERVAL_SECONDS, parsed)),
    );
  }

  const queryClient = useQueryClient();
  const tab: SettingsTab = isSettingsTab(searchParams.get('tab'))
    ? (searchParams.get('tab') as SettingsTab)
    : 'general';
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();

  const reposQuery = useQuery({
    queryKey: queryKeys.repositories,
    queryFn: () => window.runova.skills.listRepositories(),
  });

  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });

  const appVersionQuery = useQuery({
    queryKey: queryKeys.appVersion,
    queryFn: () => window.runova.app.getVersion(),
  });

  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [scheduledTasksChatId, setScheduledTasksChatId] = useState('');
  const [telegramDirty, setTelegramDirty] = useState(false);
  const [proxyDirty, setProxyDirty] = useState(false);
  const [proxyResetToken, setProxyResetToken] = useState(0);
  const proxySaveRef = useRef<(() => Promise<void>) | null>(null);
  const [detectingChatId, setDetectingChatId] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);

  useEffect(() => {
    if (!telegramDirty && settingsQuery.data) {
      setBotToken(settingsQuery.data.telegramBotToken ?? '');
      setChatId(settingsQuery.data.telegramChatId ?? '');
      setScheduledTasksChatId(settingsQuery.data.telegramScheduledTasksChatId ?? '');
    }
  }, [settingsQuery.data, telegramDirty]);

  const saveTelegramMutation = useMutation({
    mutationFn: () =>
      window.runova.settings.update({
        telegramBotToken: botToken.trim() || null,
        telegramChatId: chatId.trim() || null,
        telegramScheduledTasksChatId: scheduledTasksChatId.trim() || null,
      }),
    onSuccess: () => {
      toast.success('Telegram bot settings saved.');
      setTelegramDirty(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });

  const keepTerminalsMutation = useMutation({
    mutationFn: (keepTerminalsRunning: boolean) =>
      window.runova.settings.update({ keepTerminalsRunning }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });

  const stopDockerWithRunMutation = useMutation({
    mutationFn: (stopDockerWithRun: RunDockerStopMode) =>
      window.runova.settings.update({ stopDockerWithRun }),
    // The picker shows the choice, so there is no need for the loading overlay.
    meta: { silentLoading: true },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });

  const idleResourceSettings = useIdleResourceSettings();

  const workspaceNotificationsMutation = useMutation({
    mutationFn: (workspaceNotifications: boolean) =>
      window.runova.settings.update({ workspaceNotifications }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });

  const terminalAiNotificationsMutation = useMutation({
    mutationFn: (terminalAiNotifications: boolean) =>
      window.runova.settings.update({ terminalAiNotifications }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });

  const pipelineFailureMutation = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => window.runova.settings.update(patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });
  // The switch shows what was just clicked until the saved value comes back.
  const pipelineFailureDraft = pipelineFailureMutation.isPending
    ? pipelineFailureMutation.variables
    : undefined;

  const checkToolUpdatesMutation = useMutation({
    mutationFn: (checkToolUpdatesEnabled: boolean) =>
      window.runova.settings.update({ checkToolUpdatesEnabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });

  const startupPageMutation = useMutation({
    mutationFn: (startupPage: StartupPage) => window.runova.settings.update({ startupPage }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });

  // The shell reads the same settings query, so writing the saved answer straight into the cache
  // moves the menu in the same render. The tile shows the choice, so no loading overlay either.
  const menuPositionMutation = useMutation({
    mutationFn: (menuPosition: MenuPosition) => window.runova.settings.update({ menuPosition }),
    meta: { silentLoading: true },
    onSuccess: (next: AppSettings) => {
      queryClient.setQueryData(queryKeys.settings, next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
  const menuPosition: MenuPosition = menuPositionMutation.isPending
    ? menuPositionMutation.variables
    : (settingsQuery.data?.menuPosition ?? 'left');

  async function handleDetectChatId(): Promise<void> {
    if (!botToken.trim()) {
      toast.error('Enter your bot token first.');
      return;
    }
    setDetectingChatId(true);
    try {
      await saveTelegramMutation.mutateAsync();
      const result = await window.runova.notifications.detectChatId();
      if (!result.chatId) {
        toast.error(result.error ?? 'Could not detect a chat ID.');
        return;
      }
      setChatId(result.chatId);
      setTelegramDirty(true);
      toast.success(`Detected chat ID ${result.chatId}.`);
    } finally {
      setDetectingChatId(false);
    }
  }

  async function handleSendTest(): Promise<void> {
    setSendingTest(true);
    try {
      if (telegramDirty) await saveTelegramMutation.mutateAsync();
      const result = await window.runova.notifications.sendTest({
        message: '👋 This is a test notification from Runova.',
      });
      if (result.ok) {
        toast.success('Test message sent. Check Telegram.');
      } else {
        toast.error(result.error ?? 'Failed to send test message.');
      }
    } finally {
      setSendingTest(false);
    }
  }

  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState('');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState('');
  const [ollamaModel, setOllamaModel] = useState('');
  const [ollamaContextLength, setOllamaContextLength] = useState('');
  const [ollamaKeepAlive, setOllamaKeepAlive] = useState('');
  const [debouncedOllamaUrl, setDebouncedOllamaUrl] = useState('');
  const [ollamaTest, setOllamaTest] = useState<OllamaConnectionTest | null>(null);
  const [testingOllama, setTestingOllama] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiModel, setGeminiModel] = useState('');
  const [promptBuilderProvider, setPromptBuilderProvider] = useState<AiProvider>('openai');
  const [aiDirty, setAiDirty] = useState(false);

  useEffect(() => {
    if (!aiDirty && settingsQuery.data) {
      setOpenaiApiKey(settingsQuery.data.openaiApiKey ?? '');
      setOpenaiModel(settingsQuery.data.openaiModel);
      setOllamaBaseUrl(settingsQuery.data.ollamaBaseUrl);
      setOllamaModel(settingsQuery.data.ollamaModel);
      setOllamaContextLength(
        settingsQuery.data.ollamaContextLength
          ? String(settingsQuery.data.ollamaContextLength)
          : '',
      );
      setOllamaKeepAlive(settingsQuery.data.ollamaKeepAlive);
      setGeminiApiKey(settingsQuery.data.geminiApiKey ?? '');
      setGeminiModel(settingsQuery.data.geminiModel);
      setPromptBuilderProvider(settingsQuery.data.promptBuilderProvider);
    }
  }, [settingsQuery.data, aiDirty]);

  // Typing in the URL field shouldn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedOllamaUrl(ollamaBaseUrl), 400);
    return () => clearTimeout(timer);
  }, [ollamaBaseUrl]);

  // Only probed while the AI tab is on screen, so a stopped Ollama doesn't error on every visit.
  const ollamaModelsQuery = useQuery({
    queryKey: ['settings-ollama-models', debouncedOllamaUrl],
    queryFn: () => window.runova.ai.listOllamaModels(debouncedOllamaUrl),
    enabled: tab === 'ai' || Boolean(query),
    retry: false,
    staleTime: 30_000,
  });

  const ollamaModelOptions = useMemo(
    () => (ollamaModelsQuery.data ?? []).map((name) => ({ value: name, label: name })),
    [ollamaModelsQuery.data],
  );

  const parsedContext = Number.parseInt(ollamaContextLength.trim(), 10);
  const parsedOllamaContext =
    Number.isFinite(parsedContext) && parsedContext > 0 ? parsedContext : null;

  async function handleTestOllama(): Promise<void> {
    setTestingOllama(true);
    try {
      const result = await window.runova.ai.testOllama(ollamaBaseUrl);
      setOllamaTest(result);
      if (!result.ok) {
        toast.error(result.error ?? 'Could not reach Ollama.');
      } else if (result.modelCount === 0) {
        toast.warning('Connected, but no models are installed. Pull one with "ollama pull".');
      } else {
        toast.success(
          `Connected to Ollama${result.version ? ` ${result.version}` : ''}. ${result.modelCount} model${result.modelCount === 1 ? '' : 's'} installed.`,
        );
      }
      void ollamaModelsQuery.refetch();
    } finally {
      setTestingOllama(false);
    }
  }

  const saveAiMutation = useMutation({
    mutationFn: () =>
      window.runova.settings.update({
        openaiApiKey: openaiApiKey.trim() || null,
        openaiModel: openaiModel.trim() || DEFAULT_OPENAI_API_MODEL,
        ollamaBaseUrl: ollamaBaseUrl.trim() || 'http://localhost:11434',
        ollamaModel: ollamaModel.trim(),
        ollamaContextLength: parsedOllamaContext,
        ollamaKeepAlive: ollamaKeepAlive.trim() || '5m',
        geminiApiKey: geminiApiKey.trim() || null,
        geminiModel: geminiModel.trim() || DEFAULT_GEMINI_API_MODEL,
        promptBuilderProvider,
      }),
    onSuccess: () => {
      toast.success('AI provider settings saved.');
      setAiDirty(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });

  // The hosts editor shows the list for the chosen IP family; each family keeps its own list.
  const activePingHosts = pingIpVersion === 'ipv6' ? pingTargetsIpv6 : pingTargets;
  const [pingTargetsText, setPingTargetsText] = useState(() => activePingHosts.join(', '));
  const [pingTargetsDirty, setPingTargetsDirty] = useState(false);

  useEffect(() => {
    if (!pingTargetsDirty) setPingTargetsText(activePingHosts.join(', '));
  }, [activePingHosts, pingTargetsDirty]);

  // URLs contain no commas in practice, so they share the comma-separated chip editor.
  const [pingUrlsText, setPingUrlsText] = useState(() => pingUrls.join(', '));
  const [pingUrlsDirty, setPingUrlsDirty] = useState(false);

  useEffect(() => {
    if (!pingUrlsDirty) setPingUrlsText(pingUrls.join(', '));
  }, [pingUrls, pingUrlsDirty]);

  function splitList(text: string): string[] {
    return Array.from(
      new Set(
        text
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    );
  }

  function commitPingHosts(): void {
    if (!pingTargetsDirty) return;
    const hosts = splitList(pingTargetsText);
    if (pingIpVersion === 'ipv6') setPingTargetsIpv6(hosts);
    else setPingTargets(hosts);
    setPingTargetsDirty(false);
  }

  function handleSavePingTargets(): void {
    commitPingHosts();
    if (pingUrlsDirty) setPingUrls(splitList(pingUrlsText).filter(isHttpUrl));
    setPingUrlsDirty(false);
    toast.success('Ping targets updated.');
  }

  function handlePingIpVersionChange(version: PingIpVersion): void {
    if (version === pingIpVersion) return;
    // Keep edits typed for the family being left before its list is swapped out.
    commitPingHosts();
    setPingIpVersion(version);
  }

  const [projectsRootPath, setProjectsRootPath] = useState('');
  const [projectsRootDirty, setProjectsRootDirty] = useState(false);

  useEffect(() => {
    if (!projectsRootDirty && settingsQuery.data) {
      setProjectsRootPath(settingsQuery.data.projectsRootPath ?? '');
    }
  }, [settingsQuery.data, projectsRootDirty]);

  const saveProjectsRootMutation = useMutation({
    mutationFn: () =>
      window.runova.settings.update({ projectsRootPath: projectsRootPath.trim() || null }),
    onSuccess: (settings) => {
      setProjectsRootPath(settings.projectsRootPath ?? '');
      toast.success(
        settings.projectsRootPath
          ? 'Projects folder saved.'
          : 'Projects folder cleared. Folder pickers open wherever your system last left off.',
      );
      setProjectsRootDirty(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });

  async function handleBrowseProjectsRoot(): Promise<void> {
    const picked = await window.runova.projects.pickFolder();
    if (!picked) return;
    setProjectsRootPath(picked);
    setProjectsRootDirty(true);
  }

  const [translateMaxRetriesText, setTranslateMaxRetriesText] = useState('3');
  const [translateRetriesDirty, setTranslateRetriesDirty] = useState(false);

  useEffect(() => {
    if (!translateRetriesDirty && settingsQuery.data) {
      setTranslateMaxRetriesText(String(settingsQuery.data.translateMaxRetries));
    }
  }, [settingsQuery.data, translateRetriesDirty]);

  const saveTranslateRetriesMutation = useMutation({
    mutationFn: () => {
      const parsed = Math.max(0, Math.trunc(Number(translateMaxRetriesText)) || 0);
      return window.runova.settings.update({ translateMaxRetries: parsed });
    },
    onSuccess: (settings) => {
      setTranslateMaxRetriesText(String(settings.translateMaxRetries));
      toast.success('Translation retry setting saved.');
      setTranslateRetriesDirty(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });

  // The switch is read on every Generate in the Build Prompt dialog, so the saved answer goes into
  // the settings cache right away and the card moves in the same render, like the main menu does.
  const buildPromptSizingMutation = useMutation({
    mutationFn: (promptBuilderAutoSize: boolean) =>
      window.runova.settings.update({ promptBuilderAutoSize }),
    meta: { silentLoading: true },
    onSuccess: (next: AppSettings) => {
      queryClient.setQueryData(queryKeys.settings, next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
  const buildPromptAutoSize = buildPromptSizingMutation.isPending
    ? buildPromptSizingMutation.variables
    : (settingsQuery.data?.promptBuilderAutoSize ?? true);

  const [speechModel, setSpeechModel] = useState(DEFAULT_WHISPER_MODEL);
  const [speechLanguage, setSpeechLanguage] = useState('en');
  const [speechDirty, setSpeechDirty] = useState(false);

  useEffect(() => {
    if (!speechDirty && settingsQuery.data) {
      setSpeechModel(settingsQuery.data.speechModel);
      setSpeechLanguage(
        resolveSpeechLanguage(settingsQuery.data.speechLanguage, navigator.language),
      );
    }
  }, [settingsQuery.data, speechDirty]);

  const saveSpeechMutation = useMutation({
    mutationFn: () => window.runova.settings.update({ speechModel, speechLanguage }),
    onSuccess: () => {
      toast.success('Voice input settings saved.');
      setSpeechDirty(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });

  const [exportingBackup, setExportingBackup] = useState(false);
  const [importingBackup, setImportingBackup] = useState(false);
  const [compressBackup, setCompressBackup] = useState(false);
  const [backupEnvironments, setBackupEnvironments] = useState(false);
  const [backupVault, setBackupVault] = useState(true);
  const [backupPassword, setBackupPassword] = useState('');
  const [backupPasswordConfirm, setBackupPasswordConfirm] = useState('');
  const [pendingRestore, setPendingRestore] = useState<{
    token: string;
    environmentCount: number;
  } | null>(null);

  const backupPasswordProblem = !backupEnvironments
    ? null
    : backupPassword.length < 8
      ? 'Use at least 8 characters.'
      : backupPassword !== backupPasswordConfirm
        ? 'The passwords do not match.'
        : null;

  async function handleExportBackup(): Promise<void> {
    if (backupPasswordProblem) {
      toast.error(backupPasswordProblem);
      return;
    }
    setExportingBackup(true);
    try {
      const result = await window.runova.backup.export(compressBackup, {
        environmentsPassword: backupEnvironments ? backupPassword : undefined,
        includeVault: backupVault,
      });
      if (result.ok && result.path) {
        toast.success(`Backup saved to ${result.path}`);
        setBackupPassword('');
        setBackupPasswordConfirm('');
      } else if (result.error) toast.error(result.error);
    } finally {
      setExportingBackup(false);
    }
  }

  const restoreVaultRef = useRef(false);

  async function afterRestore(warnings: string[]): Promise<void> {
    // Rows that could not be read, plus any setting the backup carried that
    // decides what the app will execute later.
    for (const warning of warnings) toast.warning(warning);
    const restart = await confirmDialog({
      title: 'Backup restored',
      description: 'Runova needs to restart to load the restored data.',
      confirmLabel: 'Restart now',
      cancelLabel: 'Later',
    });
    if (restart) void window.runova.app.relaunch();
  }

  async function restoreBackup(
    token: string,
    environmentsPassword: string | null,
  ): Promise<'done' | 'wrong-password'> {
    const result = await window.runova.backup.restore(token, {
      environmentsPassword,
      restoreVault: restoreVaultRef.current,
    });
    if (result.wrongPassword) return 'wrong-password';
    if (!result.ok) {
      if (result.error) toast.error(result.error);
      return 'done';
    }
    void afterRestore(result.warnings ?? []);
    return 'done';
  }

  async function handleImportBackup(): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Restore from backup?',
      description:
        "This replaces your current projects, settings, templates, and other Runova data with a backup file's contents. This cannot be undone.",
      confirmLabel: 'Choose backup file…',
      variant: 'destructive',
    });
    if (!confirmed) return;

    setImportingBackup(true);
    try {
      const opened = await window.runova.backup.open();
      if (!opened.ok || !opened.token) {
        if (opened.error) toast.error(opened.error);
        return;
      }
      restoreVaultRef.current = opened.vault
        ? await confirmDialog({
            title: 'Restore the Vault too?',
            description:
              "The backup includes a Vault. Restoring it replaces this computer's Vault, which is set aside in Runova's data folder. Unlock it afterwards with the master password it had when the backup was made.",
            confirmLabel: 'Restore the Vault',
            cancelLabel: 'Keep my current Vault',
          })
        : false;
      if (opened.environments) {
        // The password dialog takes it from here.
        setPendingRestore({ token: opened.token, environmentCount: opened.environments.count });
        return;
      }
      await restoreBackup(opened.token, null);
    } finally {
      setImportingBackup(false);
    }
  }

  const updateStatus = useUpdateStore((s) => s.status);
  const checkingForUpdates = updateStatus.state === 'checking';
  const [restartingForUpdate, setRestartingForUpdate] = useState(false);

  async function handleCheckForUpdates(): Promise<void> {
    const result = await window.runova.app.checkForUpdates();
    if (result.state === 'not-available') toast.success("You're on the latest version.");
    else if (result.state === 'error') toast.error(result.message);
  }

  async function handleQuitAndInstall(): Promise<void> {
    if (restartingForUpdate) return;
    setRestartingForUpdate(true);
    try {
      await window.runova.app.quitAndInstall();
    } catch {
      setRestartingForUpdate(false);
      toast.error('Restart to install failed. Quit the app and it installs on the way out.');
    }
  }

  useEffect(() => {
    if (updateStatus.state !== 'downloaded') setRestartingForUpdate(false);
  }, [updateStatus.state]);

  function updateStatusLabel(): string {
    switch (updateStatus.state) {
      case 'checking':
        return 'Checking for updates…';
      case 'not-available':
        return "You're on the latest version.";
      case 'available':
        return updateStatus.partialBytes > 0
          ? `v${updateStatus.info.version} is available. ${formatUpdateBytes(updateStatus.partialBytes)} already on disk.`
          : `v${updateStatus.info.version} is available. Downloads resume if the connection drops.`;
      case 'downloading':
        return updateStatus.reconnecting
          ? `Connection dropped. Keeping ${formatUpdateBytes(updateStatus.progress.transferredBytes)} and retrying.`
          : `Downloading v${updateStatus.info.version}.`;
      case 'paused':
        return updateStatus.message;
      case 'downloaded':
        return `v${updateStatus.info.version} downloaded. Restart to install.`;
      case 'error':
        return updateStatus.message;
      default:
        return 'Checks run automatically every hour.';
    }
  }

  const versionLabel =
    appVersionQuery.data == null
      ? '…'
      : appVersionQuery.data === 'dev'
        ? 'dev build'
        : `v${appVersionQuery.data}`;

  const tabDirty: Record<SettingsTab, boolean> = {
    general: projectsRootDirty,
    // Default CLI, agent order and commit messages all persist the moment they change.
    agents: false,
    // Shortcuts persist the moment they change, so there is nothing to save.
    shortcuts: false,
    companion: false,
    ai: aiDirty || speechDirty || translateRetriesDirty,
    notifications: telegramDirty,
    network: proxyDirty || pingTargetsDirty || pingUrlsDirty,
    // Vault settings persist the moment they change.
    vault: false,
    data: false,
  };
  const anyDirty = Object.values(tabDirty).some(Boolean);
  const saving =
    saveProjectsRootMutation.isPending ||
    saveAiMutation.isPending ||
    saveSpeechMutation.isPending ||
    saveTranslateRetriesMutation.isPending ||
    saveTelegramMutation.isPending;

  async function handleSaveAll(): Promise<void> {
    if (projectsRootDirty) await saveProjectsRootMutation.mutateAsync();
    if (aiDirty) await saveAiMutation.mutateAsync();
    if (speechDirty) await saveSpeechMutation.mutateAsync();
    if (translateRetriesDirty) await saveTranslateRetriesMutation.mutateAsync();
    if (telegramDirty) await saveTelegramMutation.mutateAsync();
    // The proxy card keeps its own draft, so it hands its save back through a ref.
    if (proxyDirty) await proxySaveRef.current?.();
    if (pingTargetsDirty || pingUrlsDirty) handleSavePingTargets();
  }

  function handleDiscardAll(): void {
    setProjectsRootDirty(false);
    setAiDirty(false);
    setSpeechDirty(false);
    setTranslateRetriesDirty(false);
    setTelegramDirty(false);
    setPingTargetsDirty(false);
    setPingUrlsDirty(false);
    // Bumping the token is what tells the proxy card to drop its own draft.
    setProxyResetToken((token) => token + 1);
  }

  const saveAllRef = useRef(handleSaveAll);
  saveAllRef.current = handleSaveAll;
  const anyDirtyRef = useRef(anyDirty);
  anyDirtyRef.current = anyDirty;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // The shortcut recorder swallows the keys it is capturing.
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (!isShortcutLetter(event, 's')) return;
      if (!anyDirtyRef.current) return;
      event.preventDefault();
      void saveAllRef.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  usePageHeader('Settings', anyDirty ? 'You have unsaved changes.' : 'Defaults for this machine.');

  function selectTab(next: SettingsTab): void {
    const nextParams = new URLSearchParams(searchParams);
    if (next === 'general') nextParams.delete('tab');
    else nextParams.set('tab', next);
    setSearchParams(nextParams, { replace: true });
    setSearch('');
  }

  // A search spans every tab, so a card shows when it matches wherever it lives.
  function show(id: SectionId): boolean {
    return query ? sectionMatches(id, query) : tab === SECTIONS[id].tab;
  }

  /** How many cards on each tab match the search, for the counts beside the categories. */
  const matchCounts = useMemo(() => {
    const counts = Object.fromEntries(SETTINGS_TABS.map((id) => [id, 0])) as Record<
      SettingsTab,
      number
    >;
    if (!query) return counts;
    for (const id of SECTION_IDS) {
      if (sectionMatches(id, query)) counts[SECTIONS[id].tab] += 1;
    }
    return counts;
  }, [query]);
  const matchTotal = Object.values(matchCounts).reduce((sum, count) => sum + count, 0);

  /** The category name over each tab's results, so a search reads in groups. */
  function searchGroupLabel(groupTab: SettingsTab): ReactNode {
    if (!query || matchCounts[groupTab] === 0) return null;
    return (
      <p className={cn(SECTION_HEADING, '-mb-1.5 px-1 pt-2 first:pt-0')}>
        {TAB_META.find((item) => item.id === groupTab)?.label}
      </p>
    );
  }

  const searchRef = useRef<HTMLInputElement>(null);

  function clearSearch(): void {
    setSearch('');
    searchRef.current?.focus();
  }

  // Ctrl+F puts the cursor in the settings search. Nothing else claims it on this page: the
  // Vault's own Ctrl+F only runs on the Vault page.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing) return;
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (!isShortcutLetter(event, 'f')) return;
      // Keys typed into the terminal drawer belong to its shell, and an open dialog owns the
      // keyboard while it is up.
      if (event.target instanceof Element && event.target.closest('.xterm')) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const reduceMotion = useReducedMotion();
  const pillTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 32 };

  const repoCount = reposQuery.data?.length ?? 0;
  const telegramReady = Boolean(botToken.trim() && chatId.trim());
  const activeTab = TAB_META.find((item) => item.id === tab) ?? TAB_META[0];

  return (
    <div className="@container/settings flex min-h-full flex-col">
      <div className="flex w-full flex-1 flex-col @3xl/settings:flex-row @3xl/settings:gap-8 @3xl/settings:px-6">
        {/* Search sits at the top of the category list, the way Windows Settings has it, so it
            costs no row of its own. On a narrow island the two fold into one bar over the page. */}
        <aside className="sticky top-0 z-20 flex shrink-0 items-start gap-2 border-b bg-background/85 px-4 py-2.5 backdrop-blur-xl @3xl/settings:w-52 @3xl/settings:flex-col @3xl/settings:items-stretch @3xl/settings:gap-3 @3xl/settings:self-start @3xl/settings:border-b-0 @3xl/settings:bg-transparent @3xl/settings:px-0 @3xl/settings:py-6 @3xl/settings:backdrop-blur-none">
          <div className="search-pill flex h-8 w-44 shrink-0 items-center gap-2 rounded-full pl-3 pr-1.5 @3xl/settings:w-full">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && search) {
                  event.preventDefault();
                  setSearch('');
                }
              }}
              placeholder="Search settings…"
              aria-label="Search settings"
              spellCheck={false}
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
            {search ? (
              <button
                type="button"
                className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                aria-label="Clear search"
                onClick={clearSearch}
              >
                <X className="h-3 w-3" />
              </button>
            ) : (
              <kbd className="hidden shrink-0 rounded-full bg-foreground/[0.07] px-2 py-0.5 font-sans text-[10px] font-medium text-muted-foreground @3xl/settings:inline-block">
                {findShortcutLabel()}
              </kbd>
            )}
          </div>

          <nav aria-label="Settings categories" className="min-w-0 flex-1 @3xl/settings:flex-none">
            <ul className="flex flex-wrap gap-0.5 @3xl/settings:flex-col @3xl/settings:flex-nowrap @3xl/settings:gap-px">
              {TAB_META.map((item) => {
                // While searching no single tab is open; the counts say where the matches are.
                const active = !query && tab === item.id;
                const count = matchCounts[item.id];
                return (
                  <li key={item.id} className="shrink-0">
                    <button
                      type="button"
                      onClick={() => selectTab(item.id)}
                      className={cn(
                        'relative flex w-full cursor-pointer items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-[5px] text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
                        active
                          ? 'font-semibold text-primary'
                          : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
                        query && count === 0 && 'opacity-50',
                      )}
                      aria-current={active ? 'page' : undefined}
                    >
                      {active ? (
                        <motion.span
                          layoutId="settings-category-active"
                          className="absolute inset-0 rounded-lg bg-primary/12"
                          transition={pillTransition}
                        />
                      ) : null}
                      {active ? (
                        <span className="absolute left-0 top-1/2 z-10 hidden h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)] @3xl/settings:block" />
                      ) : null}
                      <item.icon className="relative z-10 h-4 w-4 shrink-0" />
                      <span className="relative z-10 flex-1 text-left">{item.label}</span>
                      {query && count > 0 ? (
                        <>
                          <span
                            aria-hidden
                            className="relative z-10 rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-primary"
                          >
                            {count}
                          </span>
                          <span className="sr-only">
                            , {count} {count === 1 ? 'match' : 'matches'}
                          </span>
                        </>
                      ) : null}
                      {tabDirty[item.id] ? (
                        <span
                          className="relative z-10 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                          aria-label="Unsaved changes"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        <div className="min-w-0 flex-1 px-4 pb-8 pt-5 @3xl/settings:max-w-4xl @3xl/settings:px-0 @3xl/settings:pt-6">
          <header className="mb-5 px-1">
            <h2 className="text-lg font-semibold tracking-tight">
              {query ? 'Search results' : activeTab.label}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {!query
                ? activeTab.description
                : matchTotal > 0
                  ? `${matchTotal} ${matchTotal === 1 ? 'setting matches' : 'settings match'} “${search.trim()}” across every category.`
                  : 'Searched every category.'}
            </p>
          </header>

          <div className="flex flex-col gap-4">
            {settingsQuery.isLoading ? (
              Array.from({ length: 4 }, (_, index) => (
                <Card key={index} className="glass">
                  <CardHeader className="flex-row items-start gap-3">
                    <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-56" />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-9 w-full" />
                  </CardContent>
                </Card>
              ))
            ) : settingsQuery.isError ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-16 text-center">
                <p className="text-sm font-medium">Could not load settings</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Something went wrong reading this machine's defaults.
                </p>
                <Button variant="soft" onClick={() => void settingsQuery.refetch()}>
                  Try again
                </Button>
              </div>
            ) : query && matchTotal === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-16 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Search className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">No settings match “{search.trim()}”</p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    Try theme, AI Pet, API key, Telegram, backup, or a category name.
                  </p>
                </div>
                <Button variant="soft" onClick={clearSearch}>
                  Clear search
                </Button>
              </div>
            ) : (
              <>
                {searchGroupLabel('general')}

                {show('appearance') && (
                  <SettingsCard
                    icon={THEME_OPTIONS.find((option) => option.value === theme)?.icon ?? Monitor}
                    title="Appearance"
                    description="How Runova looks on this machine."
                  >
                    <div
                      role="group"
                      aria-label="Theme"
                      className="grid grid-cols-1 gap-2 sm:grid-cols-3"
                    >
                      {THEME_OPTIONS.map((option) => {
                        const active = theme === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setTheme(option.value)}
                            className={cn(
                              'flex cursor-pointer flex-col rounded-lg border p-3 text-left transition-all duration-150',
                              active
                                ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/40'
                                : 'border-border bg-background/40 hover:border-foreground/20 hover:bg-accent/40',
                            )}
                            aria-pressed={active}
                          >
                            <ThemePreview mode={option.value} />
                            <div className="mt-2.5 flex items-center gap-2">
                              <option.icon className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-sm font-medium">{option.label}</span>
                            </div>
                            <p className="mt-0.5 text-xs text-muted-foreground">{option.hint}</p>
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-5 space-y-2">
                      <div>
                        <p id="menu-position-label" className="text-sm font-medium">
                          Main menu
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Keep it in the sidebar, or move it to a bar along the top so pages get the
                          full width.
                        </p>
                      </div>
                      <div
                        role="group"
                        aria-labelledby="menu-position-label"
                        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                      >
                        {MENU_POSITION_OPTIONS.map((option) => {
                          const active = menuPosition === option.value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => {
                                if (!active) menuPositionMutation.mutate(option.value);
                              }}
                              className={cn(
                                'flex cursor-pointer flex-col rounded-lg border p-3 text-left transition-all duration-150',
                                active
                                  ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/40'
                                  : 'border-border bg-background/40 hover:border-foreground/20 hover:bg-accent/40',
                              )}
                              aria-pressed={active}
                            >
                              <MenuPositionPreview position={option.value} />
                              <span className="mt-2.5 block text-sm font-medium">
                                {option.label}
                              </span>
                              <p className="mt-0.5 text-xs text-muted-foreground">{option.hint}</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </SettingsCard>
                )}

                {show('statusBarUsage') && settingsQuery.data ? (
                  <StatusBarUsageSettings settings={settingsQuery.data} />
                ) : null}

                {/* The one-control settings share a card as hairline-separated rows, so their
                  switches line up down one edge instead of each filling a card of its own. */}
                {BEHAVIOR_SECTIONS.some(show) && settingsQuery.data ? (
                  <Card className="glass settings-rows">
                    {show('startupPage') ? (
                      <SettingsRow
                        icon={History}
                        title="Startup page"
                        description="Where Runova opens. Last opened page brings back the page and project you were on, whether you closed the app, it restarted for an update or the computer shut down."
                        control={
                          <Combobox
                            ariaLabel="Startup page"
                            className="w-56"
                            value={
                              startupPageMutation.isPending
                                ? startupPageMutation.variables
                                : settingsQuery.data.startupPage
                            }
                            onChange={(value) => {
                              if (isStartupPage(value)) startupPageMutation.mutate(value);
                            }}
                            searchPlaceholder="Search pages…"
                            options={STARTUP_PAGE_OPTIONS}
                          />
                        }
                      />
                    ) : null}

                    {show('keepTerminals') ? (
                      <SettingsRow
                        icon={Power}
                        title="Keep terminals running"
                        description="Terminal sessions carry on in the background after you quit Runova, and come back with their output the next time you open it. Restarting to install an update always keeps them."
                        control={
                          <Switch
                            checked={
                              keepTerminalsMutation.isPending
                                ? keepTerminalsMutation.variables
                                : settingsQuery.data.keepTerminalsRunning
                            }
                            onCheckedChange={(checked) => keepTerminalsMutation.mutate(checked)}
                            aria-label="Keep terminals running after quitting"
                          />
                        }
                      />
                    ) : null}

                    {show('stopDockerWithRun') ? (
                      <SettingsRow
                        icon={Docker}
                        title="Docker containers when a run stops"
                        description="Stopping a run does not stop the Docker containers it brought up, so they keep using memory in the background. Choose whether Runova asks, stops them for you or leaves them alone. Only containers started with Docker Compose from the project's folder are included."
                        control={
                          <Combobox
                            ariaLabel="Docker containers when a run stops"
                            className="w-56"
                            value={
                              stopDockerWithRunMutation.isPending
                                ? stopDockerWithRunMutation.variables
                                : settingsQuery.data.stopDockerWithRun
                            }
                            onChange={(value) => {
                              if (isRunDockerStopMode(value))
                                stopDockerWithRunMutation.mutate(value);
                            }}
                            options={RUN_DOCKER_STOP_OPTIONS}
                          />
                        }
                      />
                    ) : null}

                    {show('idleResources') ? (
                      <SettingsRow
                        icon={Clock}
                        title="Idle Docker containers and emulators"
                        description="The Dashboard lists running containers and emulators that nothing has used for this long, so you can stop them and free the memory. A container counts as used while it spends CPU or moves network or disk data, an emulator while it spends CPU. The clock starts when Runova first sees something running, so restarting Runova begins it again."
                        control={
                          <div className="flex items-center gap-2">
                            <IdleMinutesInput
                              ariaLabel="Minutes before a container or emulator counts as idle"
                              value={idleResourceSettings.minutes}
                              onCommit={idleResourceSettings.setMinutes}
                            />
                            <span className="text-xs text-muted-foreground">minutes</span>
                          </div>
                        }
                      />
                    ) : null}

                    {show('idleResourceNotify') ? (
                      <SettingsRow
                        icon={Bell}
                        title="Idle resource alerts"
                        description="Get a system notification when a container or an emulator first goes idle. Clicking it opens the Dashboard, where you can stop it."
                        control={
                          <Switch
                            checked={idleResourceSettings.notify}
                            onCheckedChange={idleResourceSettings.setNotify}
                            aria-label="Notify when a container or emulator goes idle"
                          />
                        }
                      />
                    ) : null}

                    {show('workspaceNotifications') ? (
                      <SettingsRow
                        icon={Bell}
                        title="Workspace notifications"
                        description="Get a system notification when an agent in a Workspace tab finishes or asks you something while you are looking at another tab, page or app."
                        control={
                          <Switch
                            checked={
                              workspaceNotificationsMutation.isPending
                                ? workspaceNotificationsMutation.variables
                                : settingsQuery.data.workspaceNotifications
                            }
                            onCheckedChange={(checked) =>
                              workspaceNotificationsMutation.mutate(checked)
                            }
                            aria-label="Notify when a workspace agent finishes or needs input"
                          />
                        }
                      />
                    ) : null}

                    {show('terminalAiNotifications') ? (
                      <SettingsRow
                        icon={Bell}
                        title="Terminal AI notifications"
                        description="Get a system notification when an AI task in a terminal asks you something or waits for you to approve a command, while that terminal is hidden or you are in another app."
                        control={
                          <Switch
                            checked={
                              terminalAiNotificationsMutation.isPending
                                ? terminalAiNotificationsMutation.variables
                                : settingsQuery.data.terminalAiNotifications
                            }
                            onCheckedChange={(checked) =>
                              terminalAiNotificationsMutation.mutate(checked)
                            }
                            aria-label="Notify when a terminal AI task needs you"
                          />
                        }
                      />
                    ) : null}

                    {show('toolUpdates') ? (
                      <SettingsRow
                        icon={RefreshCw}
                        title="Check for CLI and tool updates"
                        description="Once a day, check every installed CLI and tool for a newer version and ring the notification bell when one is found."
                        control={
                          <Switch
                            checked={
                              checkToolUpdatesMutation.isPending
                                ? checkToolUpdatesMutation.variables
                                : settingsQuery.data.checkToolUpdatesEnabled
                            }
                            onCheckedChange={(checked) => checkToolUpdatesMutation.mutate(checked)}
                            aria-label="Automatically check for CLI and tool updates"
                          />
                        }
                      />
                    ) : null}

                    {show('terminalBackground') ? (
                      <SettingsRow
                        icon={TerminalSquare}
                        title="Workspace terminal background"
                        description="Off by default, so a Workspace terminal pane looks the way its CLI would in any ordinary terminal, for example Claude Code's own gray. Turn this on to paint a fixed background instead; the text color adjusts to stay readable on it."
                        control={
                          <Switch
                            checked={terminalCustomBackground}
                            onCheckedChange={setTerminalCustomBackground}
                            aria-label="Use a custom Workspace terminal background"
                          />
                        }
                      >
                        {terminalCustomBackground ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="color"
                              aria-label="Workspace terminal background color"
                              value={terminalBackgroundColor}
                              onChange={(event) => setTerminalBackgroundColor(event.target.value)}
                              className={COLOR_FIELD}
                            />
                            <span className="font-mono text-xs text-muted-foreground">
                              {terminalBackgroundColor}
                            </span>
                          </div>
                        ) : null}
                      </SettingsRow>
                    ) : null}
                  </Card>
                ) : null}

                {show('projectsFolder') && (
                  <SettingsCard
                    icon={FolderOpen}
                    title="Projects folder"
                    description="Folder pickers open here instead of the system default. Leave empty to use the last system location."
                    dirty={projectsRootDirty}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        value={projectsRootPath}
                        onChange={(event) => {
                          setProjectsRootPath(event.target.value);
                          setProjectsRootDirty(true);
                        }}
                        placeholder="C:\Users\you\Projects"
                        className="min-w-[16rem] flex-1 font-mono text-xs"
                        spellCheck={false}
                      />
                      <Button
                        variant="soft"
                        className="h-9 shrink-0"
                        onClick={() => void handleBrowseProjectsRoot()}
                      >
                        <FolderOpen /> Browse…
                      </Button>
                    </div>
                  </SettingsCard>
                )}

                {show('skillRepositories') && (
                  <SettingsCard
                    icon={Blocks}
                    title="Skill repositories"
                    description={
                      reposQuery.isLoading
                        ? 'Loading repositories…'
                        : `${repoCount} repositor${repoCount === 1 ? 'y' : 'ies'} configured. Add and sync sources from the Skills page.`
                    }
                    action={
                      <Button variant="soft" onClick={() => navigate('/skills')}>
                        <Blocks /> Manage
                      </Button>
                    }
                  />
                )}

                {show('blueprintPresets') && (
                  <SettingsCard
                    icon={Route}
                    title="Blueprint presets"
                    description="Reusable snippets for a project's Blueprint. Clicking one in the wizard appends it to that step."
                  >
                    <BlueprintPresetSettings />
                  </SettingsCard>
                )}

                {show('androidSdk') && settingsQuery.data ? (
                  <AndroidSdkSettings settings={settingsQuery.data} />
                ) : null}

                {searchGroupLabel('agents')}

                {show('defaultCli') && (
                  <SettingsCard
                    icon={TerminalSquare}
                    title="Default CLI"
                    description="Used when a feature needs an AI provider without asking."
                  >
                    <div className="max-w-sm space-y-3">
                      <Combobox
                        value={defaultCliId ?? ''}
                        onChange={(value) => setDefaultCliId(value || null)}
                        placeholder="No default set"
                        searchPlaceholder="Search CLIs…"
                        options={CLI_REGISTRY.map((cli) => ({
                          value: cli.id,
                          label: cli.name,
                          icon: cliOptionIcon(cli.id),
                        }))}
                        clearable
                      />
                      {/* Per CLI, not per default: switching the default brings up that
                        CLI's own flags. Every CLI has the same field in CLI Manager. */}
                      {defaultCliId && <CliArgsField cliId={defaultCliId} />}
                    </div>
                  </SettingsCard>
                )}

                {show('launchDefaults') && (
                  <SettingsCard
                    icon={Play}
                    title="Launch defaults"
                    description="The model, effort, and mode each agent starts with. Anything left on Not set is up to the CLI."
                  >
                    <div className="max-w-3xl">
                      <CliLaunchDefaultsSettings />
                    </div>
                  </SettingsCard>
                )}

                {show('agentTabView') && (
                  <SettingsCard
                    icon={MessageSquare}
                    title="Default view for agent tabs"
                    description="How an agent tab in the Workspace opens: as its CLI, or as a chat drawn from the same running CLI. Right-click a tab to switch just that one; a tab you switched keeps its own choice."
                  >
                    <AgentTabViewSettings />
                  </SettingsCard>
                )}

                {show('agentOrder') && (
                  <SettingsCard
                    icon={TerminalSquare}
                    title="Agent order"
                    description="The order agents are listed in when you start one in the Workspace."
                  >
                    <div className="max-w-xl">
                      <CliOrderSettings />
                    </div>
                  </SettingsCard>
                )}

                {show('commitMessages') && (
                  <SettingsCard
                    icon={GitCommit}
                    title="Commit messages"
                    description="How the sparkle button in the Workspace changes panel writes a commit message for you."
                  >
                    <CommitMessageSettingsForm />
                  </SettingsCard>
                )}

                {show('worktrees') && (
                  <SettingsCard
                    icon={GitBranch}
                    title="Worktrees"
                    description="Where new git worktrees go, which local files they start with, and how removing one tidies up."
                  >
                    <WorktreeSettingsForm />
                  </SettingsCard>
                )}

                {show('studio') && (
                  <SettingsCard
                    icon={Clapperboard}
                    title="Studio"
                    description="Where your videos are kept, how much room working files may take, and how renders run."
                  >
                    <StudioSettingsSection />
                  </SettingsCard>
                )}

                {show('reviewCommands') && (
                  <SettingsCard
                    icon={GitPullRequest}
                    title="Review commands"
                    description="The comments offered in the workspace Pull request tab to ask a review bot to look at the pull request."
                  >
                    <ReviewCommandsSettings />
                  </SettingsCard>
                )}

                {searchGroupLabel('shortcuts')}

                {show('shortcuts') && (
                  <SettingsCard
                    icon={Keyboard}
                    title="Keyboard shortcuts"
                    description="Rebind the app, Workspace and commit box shortcuts. Changes apply right away."
                  >
                    <ShortcutSettings />
                  </SettingsCard>
                )}

                {searchGroupLabel('companion')}

                {show('companion') && settingsQuery.data ? (
                  <CompanionSettings settings={settingsQuery.data} />
                ) : null}

                {searchGroupLabel('ai')}

                {show('providers') && (
                  <SettingsCard
                    icon={MessageSquare}
                    title="Providers"
                    description="Keys and models used by Ask AI and Prompt Builder."
                    dirty={aiDirty}
                  >
                    <div className="space-y-5">
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            OpenAI
                          </p>
                          <Badge
                            variant={openaiApiKey.trim() ? 'success' : 'secondary'}
                            className="font-normal"
                          >
                            {openaiApiKey.trim() ? 'Key set' : 'No key'}
                          </Badge>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field
                            label="API key"
                            htmlFor="openai-api-key"
                            hint={
                              <>
                                Create one at{' '}
                                <ExternalLinkButton href="https://platform.openai.com/api-keys">
                                  platform.openai.com/api-keys
                                </ExternalLinkButton>
                                .
                              </>
                            }
                            className="sm:col-span-2"
                          >
                            <SecretInput
                              id="openai-api-key"
                              value={openaiApiKey}
                              onChange={(value) => {
                                setOpenaiApiKey(value);
                                setAiDirty(true);
                              }}
                              placeholder="sk-…"
                            />
                          </Field>
                          <Field label="Default model" htmlFor="openai-model">
                            <Input
                              id="openai-model"
                              value={openaiModel}
                              onChange={(event) => {
                                setOpenaiModel(event.target.value);
                                setAiDirty(true);
                              }}
                              placeholder={DEFAULT_OPENAI_API_MODEL}
                              className="font-mono"
                              spellCheck={false}
                            />
                          </Field>
                        </div>
                      </div>

                      <div className="space-y-3 border-t border-border/60 pt-5">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Gemini
                          </p>
                          <Badge
                            variant={geminiApiKey.trim() ? 'success' : 'secondary'}
                            className="font-normal"
                          >
                            {geminiApiKey.trim() ? 'Key set' : 'No key'}
                          </Badge>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field
                            label="API key"
                            htmlFor="gemini-api-key"
                            hint={
                              <>
                                Create one at{' '}
                                <ExternalLinkButton href="https://aistudio.google.com/apikey">
                                  aistudio.google.com/apikey
                                </ExternalLinkButton>
                                .
                              </>
                            }
                            className="sm:col-span-2"
                          >
                            <SecretInput
                              id="gemini-api-key"
                              value={geminiApiKey}
                              onChange={(value) => {
                                setGeminiApiKey(value);
                                setAiDirty(true);
                              }}
                              placeholder="AIza…"
                            />
                          </Field>
                          <Field label="Default model" htmlFor="gemini-model">
                            <Input
                              id="gemini-model"
                              value={geminiModel}
                              onChange={(event) => {
                                setGeminiModel(event.target.value);
                                setAiDirty(true);
                              }}
                              placeholder={DEFAULT_GEMINI_API_MODEL}
                              className="font-mono"
                              spellCheck={false}
                            />
                          </Field>
                        </div>
                      </div>

                      <div className="space-y-3 border-t border-border/60 pt-5">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Ollama
                          </p>
                          {ollamaTest ? (
                            <Badge
                              variant={ollamaTest.ok ? 'success' : 'destructive'}
                              className="font-normal"
                            >
                              {ollamaTest.ok
                                ? ollamaTest.version
                                  ? `Connected · ${ollamaTest.version}`
                                  : 'Connected'
                                : 'Not reachable'}
                            </Badge>
                          ) : null}
                        </div>
                        <Field
                          label="Server URL"
                          htmlFor="ollama-base-url"
                          hint={
                            <>
                              Address of a running{' '}
                              <ExternalLinkButton href="https://ollama.com">
                                Ollama
                              </ExternalLinkButton>{' '}
                              instance. Leave the default if it runs on this machine.
                            </>
                          }
                        >
                          <div className="flex max-w-xl items-center gap-2">
                            <Input
                              id="ollama-base-url"
                              value={ollamaBaseUrl}
                              onChange={(event) => {
                                setOllamaBaseUrl(event.target.value);
                                setOllamaTest(null);
                                setAiDirty(true);
                              }}
                              placeholder="http://localhost:11434"
                              className="font-mono"
                              spellCheck={false}
                            />
                            <Button
                              variant="soft"
                              className="h-9 shrink-0"
                              disabled={testingOllama}
                              onClick={() => void handleTestOllama()}
                            >
                              {testingOllama ? 'Testing…' : 'Test connection'}
                            </Button>
                          </div>
                        </Field>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field
                            label="Default model"
                            hint="Picked first on the Ask AI page and used by Prompt Builder. The list comes from the server above."
                          >
                            <div className="flex items-center gap-2">
                              <Combobox
                                className="min-w-0 flex-1"
                                value={ollamaModel}
                                onChange={(value) => {
                                  setOllamaModel(value);
                                  setAiDirty(true);
                                }}
                                options={ollamaModelOptions}
                                placeholder={
                                  ollamaModelsQuery.isFetching
                                    ? 'Loading models…'
                                    : 'Choose a model'
                                }
                                emptyText="No models found. Is Ollama running?"
                                clearable
                              />
                              <SimpleTooltip label="Refresh model list" wrapTrigger>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  className="shrink-0"
                                  aria-label="Refresh model list"
                                  disabled={ollamaModelsQuery.isFetching}
                                  onClick={() => void ollamaModelsQuery.refetch()}
                                >
                                  <RefreshCw className="h-3.5 w-3.5" />
                                </Button>
                              </SimpleTooltip>
                            </div>
                          </Field>
                          <Field
                            label="Context length"
                            htmlFor="ollama-context-length"
                            hint="Tokens the model keeps in its window (num_ctx). Leave empty to use whatever the model ships with. Bigger values need more RAM or VRAM."
                          >
                            <Input
                              id="ollama-context-length"
                              inputMode="numeric"
                              value={ollamaContextLength}
                              onChange={(event) => {
                                setOllamaContextLength(event.target.value.replace(/[^0-9]/g, ''));
                                setAiDirty(true);
                              }}
                              placeholder="Model default (e.g. 8192)"
                              className="font-mono"
                              spellCheck={false}
                            />
                          </Field>
                          <Field
                            label="Keep model in memory"
                            htmlFor="ollama-keep-alive"
                            hint='How long Ollama holds the model in RAM after a request (keep_alive). Use "5m", "1h", "0" to free it right away, or "-1" to keep it loaded.'
                          >
                            <Input
                              id="ollama-keep-alive"
                              value={ollamaKeepAlive}
                              onChange={(event) => {
                                setOllamaKeepAlive(event.target.value);
                                setAiDirty(true);
                              }}
                              placeholder="5m"
                              className="font-mono"
                              spellCheck={false}
                            />
                          </Field>
                        </div>
                      </div>

                      <div className="border-t border-border/60 pt-5">
                        <Field
                          label="Prompt Builder provider"
                          hint="Used by Generate Prompt. Uses the key and model for that provider above."
                        >
                          <Combobox
                            className="w-40"
                            value={promptBuilderProvider}
                            onChange={(value) => {
                              setPromptBuilderProvider(value as AiProvider);
                              setAiDirty(true);
                            }}
                            options={PROMPT_BUILDER_PROVIDER_OPTIONS}
                          />
                        </Field>
                      </div>
                    </div>
                  </SettingsCard>
                )}

                {show('voiceInput') && (
                  <SettingsCard
                    icon={Microphone}
                    title="Voice input"
                    description="Local Whisper transcription for Prompt Builder. The model downloads once and stays cached."
                    dirty={speechDirty}
                  >
                    <div className="grid max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Model">
                        <Combobox
                          ariaLabel="Speech model"
                          value={speechModel}
                          onChange={(value) => {
                            setSpeechModel(value);
                            setSpeechDirty(true);
                          }}
                          options={WHISPER_MODELS.map((m) => ({ value: m.key, label: m.label }))}
                        />
                      </Field>
                      <Field label="Spoken language">
                        <Combobox
                          ariaLabel="Spoken language"
                          value={speechLanguage}
                          onChange={(value) => {
                            setSpeechLanguage(value);
                            setSpeechDirty(true);
                          }}
                          options={SPEECH_LANGUAGE_OPTIONS}
                        />
                      </Field>
                    </div>
                    <SpeechModelHint
                      modelKey={speechModel}
                      languageCode={speechLanguage}
                      onUseModel={(key) => {
                        setSpeechModel(key);
                        setSpeechDirty(true);
                      }}
                    />
                  </SettingsCard>
                )}

                {show('helpSearch') && settingsQuery.data ? (
                  <HelpSearchSettings settings={settingsQuery.data} />
                ) : null}

                {show('writingCheck') && settingsQuery.data ? (
                  <WritingCheckSettings settings={settingsQuery.data} />
                ) : null}

                {show('translationRetries') && (
                  <SettingsCard
                    icon={Languages}
                    title="Translation retries"
                    description="Extra attempts Prompt Builder makes if a translate request fails."
                    dirty={translateRetriesDirty}
                  >
                    <Input
                      type="number"
                      min={0}
                      max={10}
                      value={translateMaxRetriesText}
                      onChange={(event) => {
                        setTranslateMaxRetriesText(event.target.value);
                        setTranslateRetriesDirty(true);
                      }}
                      className="w-24"
                    />
                  </SettingsCard>
                )}

                {show('buildPromptSizing') && (
                  <SettingsCard
                    icon={Robot}
                    title="Build Prompt sizing"
                    description="Works out the model and effort a prompt needs in the Build Prompt dialog."
                  >
                    <div className="flex items-center gap-2">
                      <Switch
                        id="build-prompt-auto-size"
                        checked={buildPromptAutoSize}
                        onCheckedChange={(checked) => buildPromptSizingMutation.mutate(checked)}
                      />
                      <Label htmlFor="build-prompt-auto-size" className="font-normal">
                        Size right after Generate or Translate
                      </Label>
                    </div>
                    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                      When this is off, click the Recommended run chip in the Build Prompt dialog to
                      size the prompt. The Prompt Builder page always sizes after Generate or
                      Translate.
                    </p>
                  </SettingsCard>
                )}

                {searchGroupLabel('notifications')}

                {show('pipelineFailures') && settingsQuery.data ? (
                  <Card className="glass settings-rows">
                    <SettingsRow
                      icon={Bell}
                      title="Show failed pipelines in notifications"
                      description="When a GitHub Actions run fails, flash a message in the corner, keep it in Recent messages and mark Pipelines as unread."
                      control={
                        <Switch
                          checked={
                            (pipelineFailureDraft?.pipelineFailureNotify ??
                              settingsQuery.data.pipelineFailureNotify) !== false
                          }
                          onCheckedChange={(checked) =>
                            pipelineFailureMutation.mutate({ pipelineFailureNotify: checked })
                          }
                          aria-label="Show failed pipelines in notifications"
                        />
                      }
                    />
                    <SettingsRow
                      icon={Paw}
                      title="Show failed pipelines on my AI Pet"
                      description={
                        settingsQuery.data.desktopPetEnabled
                          ? 'The pet says which workflow failed in a short message next to it.'
                          : 'The pet says which workflow failed. Turn on My AI Pet in the AI Pet tab first.'
                      }
                      control={
                        <Switch
                          checked={
                            (pipelineFailureDraft?.desktopPetPipelineOnFail ??
                              settingsQuery.data.desktopPetPipelineOnFail) === true
                          }
                          disabled={!settingsQuery.data.desktopPetEnabled}
                          onCheckedChange={(checked) =>
                            pipelineFailureMutation.mutate({ desktopPetPipelineOnFail: checked })
                          }
                          aria-label="Show failed pipelines on my AI Pet"
                        />
                      }
                    />
                    <SettingsRow
                      icon={Route}
                      title="When I click a failure"
                      description="Where the message, its row in Recent messages and the pet's bubble take you. The project workspace opens the Pipelines section of that project's Git panel, the Pipelines page lists the run among every project's runs."
                      control={
                        <Combobox
                          ariaLabel="When I click a failure"
                          className="w-56"
                          value={
                            pipelineFailureDraft?.pipelineFailureOpen ??
                            settingsQuery.data.pipelineFailureOpen
                          }
                          onChange={(value) => {
                            if (isPipelineFailureOpen(value)) {
                              pipelineFailureMutation.mutate({ pipelineFailureOpen: value });
                            }
                          }}
                          searchPlaceholder="Search…"
                          options={PIPELINE_FAILURE_OPEN_OPTIONS}
                        />
                      }
                    />
                  </Card>
                ) : null}

                {show('news') ? (
                  <Card className="glass settings-rows">
                    <NewsSettings />
                  </Card>
                ) : null}

                {show('ciAutoFix') ? (
                  <Card className="glass settings-rows">
                    <CiAutoFixSettings />
                  </Card>
                ) : null}

                {show('telegram') && (
                  <SettingsCard
                    icon={Bell}
                    title="Telegram bot"
                    description="Used by project notification hooks and scheduled task updates."
                    dirty={telegramDirty}
                    action={
                      <Badge
                        variant={telegramReady ? 'success' : 'secondary'}
                        className="font-normal"
                      >
                        {telegramReady ? 'Ready' : 'Not configured'}
                      </Badge>
                    }
                  >
                    <div className="space-y-4">
                      <ol className="list-decimal space-y-1 pl-4 text-sm text-muted-foreground">
                        <li>
                          Create a bot with{' '}
                          <ExternalLinkButton href="https://t.me/BotFather">
                            @BotFather
                          </ExternalLinkButton>{' '}
                          and paste its token.
                        </li>
                        <li>Message the bot once on Telegram, then detect the chat ID.</li>
                      </ol>

                      <Field label="Bot token" htmlFor="telegram-bot-token">
                        {/* The width goes on a wrapper, so the reveal button stays inside the field. */}
                        <div className="max-w-md">
                          <SecretInput
                            id="telegram-bot-token"
                            value={botToken}
                            onChange={(value) => {
                              setBotToken(value);
                              setTelegramDirty(true);
                            }}
                            placeholder="123456789:AAExampleTokenFromBotFather"
                          />
                        </div>
                      </Field>

                      <Field
                        label="Chat ID"
                        htmlFor="telegram-chat-id"
                        hint="Message your bot once on Telegram, then click detect."
                      >
                        <div className="flex flex-wrap gap-2">
                          <Input
                            id="telegram-chat-id"
                            value={chatId}
                            onChange={(event) => {
                              setChatId(event.target.value);
                              setTelegramDirty(true);
                            }}
                            placeholder="e.g. 123456789"
                            className="max-w-xs font-mono"
                            spellCheck={false}
                          />
                          <Button
                            variant="soft"
                            className="h-9 shrink-0"
                            type="button"
                            disabled={detectingChatId || !botToken.trim()}
                            onClick={() => void handleDetectChatId()}
                          >
                            {detectingChatId ? 'Detecting…' : 'Detect from last message'}
                          </Button>
                        </div>
                      </Field>

                      <Field
                        label="Scheduled tasks chat/group ID"
                        htmlFor="telegram-scheduled-tasks-chat-id"
                        hint="Optional. Scheduled tasks post here and the message updates as status changes."
                      >
                        <Input
                          id="telegram-scheduled-tasks-chat-id"
                          value={scheduledTasksChatId}
                          onChange={(event) => {
                            setScheduledTasksChatId(event.target.value);
                            setTelegramDirty(true);
                          }}
                          placeholder="e.g. -1001234567890"
                          className="max-w-xs font-mono"
                          spellCheck={false}
                        />
                      </Field>

                      <Button
                        variant="soft"
                        disabled={
                          sendingTest || (!botToken.trim() && !settingsQuery.data?.telegramBotToken)
                        }
                        onClick={() => void handleSendTest()}
                      >
                        {sendingTest ? 'Sending…' : 'Send test'}
                      </Button>
                    </div>
                  </SettingsCard>
                )}

                {searchGroupLabel('network')}

                {show('proxy') && settingsQuery.data ? (
                  <ProxySettings
                    settings={settingsQuery.data}
                    onDirtyChange={setProxyDirty}
                    saveRef={proxySaveRef}
                    resetToken={proxyResetToken}
                  />
                ) : null}

                {show('pingTargets') && (
                  <SettingsCard
                    icon={NetworkIcon}
                    title="Network ping targets"
                    description="How connection quality is measured for the status bar and the dashboard Network Status graph. The AI pet uses it too if internet alerts are on. Press Enter to add an entry."
                    dirty={pingTargetsDirty || pingUrlsDirty}
                  >
                    <div className="space-y-4">
                      {pingMethod !== 'http' && (
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">IP version</Label>
                          <div
                            role="radiogroup"
                            aria-label="Ping IP version"
                            className="flex flex-col gap-2 sm:flex-row"
                          >
                            {PING_IP_OPTIONS.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                role="radio"
                                aria-checked={pingIpVersion === option.value}
                                onClick={() => handlePingIpVersionChange(option.value)}
                                className={cn(
                                  'flex flex-1 cursor-pointer flex-col rounded-lg border px-3 py-2 text-left transition-colors',
                                  pingIpVersion === option.value
                                    ? 'border-primary/60 bg-primary/10'
                                    : 'border-input hover:bg-accent',
                                )}
                              >
                                <div className="text-sm font-medium">{option.label}</div>
                                <div className="text-[11px] text-muted-foreground">
                                  {option.hint}
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Method</Label>
                        <div
                          role="radiogroup"
                          aria-label="Ping method"
                          className="flex flex-col gap-2 sm:flex-row"
                        >
                          {PING_METHOD_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              role="radio"
                              aria-checked={pingMethod === option.value}
                              onClick={() => setPingMethod(option.value)}
                              className={cn(
                                'flex flex-1 cursor-pointer flex-col rounded-lg border px-3 py-2 text-left transition-colors',
                                pingMethod === option.value
                                  ? 'border-primary/60 bg-primary/10'
                                  : 'border-input hover:bg-accent',
                              )}
                            >
                              <div className="text-sm font-medium">{option.label}</div>
                              <div className="text-[11px] text-muted-foreground">{option.hint}</div>
                            </button>
                          ))}
                        </div>
                      </div>

                      {pingMethod !== 'http' && (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs text-muted-foreground">Hosts to ping</Label>
                            <Button
                              variant="soft"
                              size="sm"
                              onClick={() => {
                                setPingTargetsText(
                                  (pingIpVersion === 'ipv6'
                                    ? DEFAULT_PING_TARGETS_IPV6
                                    : DEFAULT_PING_TARGETS_IPV4
                                  ).join(', '),
                                );
                                setPingTargetsDirty(true);
                              }}
                            >
                              Reset to default
                            </Button>
                          </div>
                          <HostChips
                            ariaLabel="Hosts to ping"
                            value={pingTargetsText}
                            onChange={(value) => {
                              setPingTargetsText(value);
                              setPingTargetsDirty(true);
                            }}
                          />
                        </div>
                      )}

                      {pingMethod !== 'icmp' && (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs text-muted-foreground">URLs to request</Label>
                            <Button
                              variant="soft"
                              size="sm"
                              onClick={() => {
                                setPingUrlsText(DEFAULT_PING_URL);
                                setPingUrlsDirty(true);
                              }}
                            >
                              Reset to default
                            </Button>
                          </div>
                          <HostChips
                            ariaLabel="URLs to request"
                            placeholder={DEFAULT_PING_URL}
                            validate={isHttpUrl}
                            value={pingUrlsText}
                            onChange={(value) => {
                              setPingUrlsText(value);
                              setPingUrlsDirty(true);
                            }}
                          />
                          <div className="flex items-center gap-2 pt-1">
                            <Label
                              htmlFor="ping-url-interval"
                              className="text-xs text-muted-foreground"
                            >
                              Request every
                            </Label>
                            <Input
                              id="ping-url-interval"
                              type="number"
                              inputMode="numeric"
                              min={MIN_PING_URL_INTERVAL_SECONDS}
                              max={MAX_PING_URL_INTERVAL_SECONDS}
                              className="h-8 w-20"
                              value={pingIntervalDraft ?? String(pingUrlIntervalSeconds)}
                              onChange={(event) => setPingIntervalDraft(event.target.value)}
                              onBlur={commitPingInterval}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') commitPingInterval();
                              }}
                            />
                            <span className="text-xs text-muted-foreground">
                              seconds ({MIN_PING_URL_INTERVAL_SECONDS} to{' '}
                              {MAX_PING_URL_INTERVAL_SECONDS})
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            Use this when the network blocks the ping command. Any reply from the
                            server counts as online, and the time to reply is the latency.
                          </p>
                        </div>
                      )}
                    </div>
                  </SettingsCard>
                )}

                {searchGroupLabel('vault')}

                {show('vault') && settingsQuery.data ? (
                  <VaultSettings settings={settingsQuery.data} />
                ) : null}

                {searchGroupLabel('data')}

                {show('backup') && (
                  <SettingsCard
                    icon={HardDrive}
                    title="Backup & restore"
                    description="Exports include projects, settings, templates, and saved keys, plus project environments when you set a password. Keep the file private. Restoring replaces everything on this machine."
                  >
                    <div className="space-y-4">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-lg border border-border bg-background/40 p-4">
                          <p className="text-sm font-medium">Export</p>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            Save a copy of this machine's Runova data.
                          </p>
                          <div className="mt-3 flex items-center gap-2">
                            <Switch
                              id="compress-backup"
                              checked={compressBackup}
                              onCheckedChange={setCompressBackup}
                            />
                            <Label
                              htmlFor="compress-backup"
                              className="font-normal text-muted-foreground"
                            >
                              Compress as .zip
                            </Label>
                          </div>
                          <div className="mt-3 flex items-center gap-2">
                            <Switch
                              id="backup-environments"
                              checked={backupEnvironments}
                              onCheckedChange={setBackupEnvironments}
                            />
                            <Label
                              htmlFor="backup-environments"
                              className="font-normal text-muted-foreground"
                            >
                              Include project environments
                            </Label>
                          </div>
                          <div className="mt-3 flex items-center gap-2">
                            <Switch
                              id="backup-vault"
                              checked={backupVault}
                              onCheckedChange={setBackupVault}
                            />
                            <Label
                              htmlFor="backup-vault"
                              className="font-normal text-muted-foreground"
                            >
                              Include the Vault (stays encrypted with its master password)
                            </Label>
                          </div>
                          {backupEnvironments && (
                            <div className="mt-3 space-y-2">
                              <SecretInput
                                value={backupPassword}
                                onChange={setBackupPassword}
                                placeholder="Backup password"
                              />
                              <SecretInput
                                value={backupPasswordConfirm}
                                onChange={setBackupPasswordConfirm}
                                placeholder="Confirm password"
                              />
                              <p className="text-xs leading-relaxed text-muted-foreground">
                                Env files and credentials are encrypted with this password. You need
                                it to restore them, and it cannot be recovered.
                              </p>
                              {backupPassword && backupPasswordProblem && (
                                <p className="text-xs text-destructive">{backupPasswordProblem}</p>
                              )}
                            </div>
                          )}
                          <Button
                            variant="soft"
                            className="mt-3"
                            disabled={exportingBackup || backupPasswordProblem !== null}
                            onClick={() => void handleExportBackup()}
                          >
                            <Download className="h-4 w-4" />
                            {exportingBackup ? 'Exporting…' : 'Export backup'}
                          </Button>
                        </div>
                        <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-4">
                          <p className="text-sm font-medium">Restore</p>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            Replaces current data. This cannot be undone.
                          </p>
                          <Button
                            variant="danger"
                            className="mt-8"
                            disabled={importingBackup}
                            onClick={() => void handleImportBackup()}
                          >
                            <Upload className="h-4 w-4" />
                            {importingBackup ? 'Restoring…' : 'Restore from backup…'}
                          </Button>
                        </div>
                      </div>
                    </div>
                    <BackupEnvironmentsPasswordDialog
                      open={pendingRestore !== null}
                      onOpenChange={(open) => {
                        if (!open) setPendingRestore(null);
                      }}
                      environmentCount={pendingRestore?.environmentCount ?? 0}
                      onRestore={(password) =>
                        pendingRestore
                          ? restoreBackup(pendingRestore.token, password)
                          : Promise.resolve('done')
                      }
                    />
                  </SettingsCard>
                )}

                {show('about') && (
                  <SettingsCard
                    icon={CircleQuestion}
                    title="About"
                    description={`Runova ${versionLabel}`}
                    action={
                      updateStatus.state === 'downloaded' ? (
                        <Button
                          disabled={restartingForUpdate}
                          onClick={() => void handleQuitAndInstall()}
                        >
                          {restartingForUpdate ? 'Restarting…' : 'Restart now'}
                        </Button>
                      ) : updateStatus.state === 'downloading' ? (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="soft"
                            onClick={() => void window.runova.app.pauseDownload()}
                          >
                            <Pause className="h-4 w-4" />
                            Pause
                          </Button>
                          <Button variant="soft" onClick={() => openUpdateDialog()}>
                            Show
                          </Button>
                        </div>
                      ) : updateStatus.state === 'paused' ||
                        (updateStatus.state === 'error' && updateStatus.resumable) ||
                        updateStatus.state === 'available' ? (
                        <Button
                          onClick={() => {
                            openUpdateDialog();
                            void window.runova.app.downloadUpdate();
                          }}
                        >
                          {updateStatus.state === 'available' && updateStatus.partialBytes === 0 ? (
                            <>
                              <Download className="h-4 w-4" />
                              Download
                            </>
                          ) : (
                            <>
                              <Play className="h-4 w-4" />
                              Resume download
                            </>
                          )}
                        </Button>
                      ) : (
                        <Button
                          variant="soft"
                          disabled={checkingForUpdates}
                          onClick={() => void handleCheckForUpdates()}
                        >
                          <RefreshCw
                            className={cn('h-4 w-4', checkingForUpdates && 'animate-spin')}
                          />
                          {checkingForUpdates ? 'Checking…' : 'Check for updates'}
                        </Button>
                      )
                    }
                  >
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">{updateStatusLabel()}</p>
                      {updatePercent(updateStatus) != null &&
                      updateStatus.state !== 'downloaded' &&
                      updateStatus.state !== 'idle' ? (
                        <UpdateProgressTrack
                          percent={updatePercent(updateStatus) ?? 0}
                          live={updateStatus.state === 'downloading'}
                          reconnecting={
                            updateStatus.state === 'downloading' && updateStatus.reconnecting
                          }
                        />
                      ) : null}
                    </div>
                  </SettingsCard>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {anyDirty ? (
        <div className="sticky bottom-0 z-20 border-t border-border/80 bg-background/85 px-4 py-3 backdrop-blur-xl @3xl/settings:px-6">
          <div className="flex w-full items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Unsaved changes
              <span className="ml-2 hidden text-xs sm:inline">({saveShortcutLabel()} to save)</span>
            </p>
            <div className="flex items-center gap-2">
              <Button variant="soft" disabled={saving} onClick={handleDiscardAll}>
                Discard
              </Button>
              <SimpleTooltip label={`Save all changes (${saveShortcutLabel()})`}>
                <Button disabled={saving} onClick={() => void handleSaveAll()}>
                  <Save className="h-4 w-4" />
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
              </SimpleTooltip>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Says when the picked Whisper model is too small for the spoken language, and offers one that is not. */
function SpeechModelHint({
  modelKey,
  languageCode,
  onUseModel,
}: {
  modelKey: string;
  languageCode: string;
  onUseModel: (key: string) => void;
}): React.JSX.Element | null {
  if (!speechModelTooSmallFor(modelKey, languageCode)) return null;
  const lang = SPEECH_LANGUAGES.find((l) => l.code === languageCode);
  const better = WHISPER_MODELS.find((m) => m.key === lang?.recommendedModel);
  if (!lang || !better) return null;
  return (
    <div
      role="note"
      className="mt-3 flex max-w-lg items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs"
    >
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1 space-y-2">
        <p>
          This model often gets {lang.label} wrong. {better.label} understands it far better.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => onUseModel(better.key)}>
          Use this model
        </Button>
      </div>
    </div>
  );
}
