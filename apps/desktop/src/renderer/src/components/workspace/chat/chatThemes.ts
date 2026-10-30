import { CLI_REGISTRY } from '@runova/core';

/**
 * How a tab's chat view looks for the CLI behind it, so a Claude Code chat feels like Claude, a
 * Codex chat like Codex and a Gemini chat like Gemini. Every value is a set of Tailwind classes
 * with its own dark variant, so each look follows the app theme.
 */
export interface ChatTheme {
  /** The CLI's name, for the header and the composer. */
  name: string;
  /** The view's background and text. */
  surface: string;
  /** Text in the CLI's own color: the working dots, links and the status line. */
  accentText: string;
  /** The Send button. */
  accentButton: string;
  /** The halo behind the logo on the empty screen. */
  glow: string;
  userBubble: string;
  /** The reply text, which for Claude is set in a serif like Claude's own apps. */
  replyText: string;
  /** Tool cards and the thinking block. */
  card: string;
  /** The header strip along the top. */
  header: string;
}

const CLAUDE: Omit<ChatTheme, 'name'> = {
  surface: 'bg-[#faf9f5] text-[#141413] dark:bg-[#262624] dark:text-[#faf9f5]',
  accentText: 'text-[#c96442] dark:text-[#e08a6d]',
  accentButton:
    'bg-[#c96442] text-white hover:bg-[#b5573a] dark:bg-[#d97757] dark:hover:bg-[#e08a6d]',
  glow: 'bg-[#c96442]/15 shadow-[0_0_48px_-8px_#c96442aa]',
  userBubble:
    'rounded-2xl rounded-br-md bg-[#f0eee6] text-[#141413] ring-1 ring-inset ring-[#1f1e1d]/[0.06] dark:bg-[#141413] dark:text-[#faf9f5] dark:ring-white/[0.06]',
  replyText: 'font-serif text-[15px] leading-7',
  card: 'rounded-xl border border-[#1f1e1d]/10 bg-white/70 dark:border-white/10 dark:bg-[#30302e]',
  header: 'border-b border-[#1f1e1d]/[0.08] dark:border-white/[0.08]',
};

const CODEX: Omit<ChatTheme, 'name'> = {
  surface: 'bg-white text-[#0d0d0d] dark:bg-[#0d0d0d] dark:text-[#ececec]',
  accentText: 'text-[#0d0d0d] dark:text-white',
  accentButton:
    'bg-[#0d0d0d] text-white hover:bg-[#2f2f2f] dark:bg-white dark:text-[#0d0d0d] dark:hover:bg-[#d9d9d9]',
  glow: 'bg-black/[0.06] shadow-[0_0_48px_-12px_#00000055] dark:bg-white/10 dark:shadow-[0_0_48px_-12px_#ffffff55]',
  userBubble: 'rounded-3xl bg-[#f4f4f4] text-[#0d0d0d] dark:bg-[#2f2f2f] dark:text-[#ececec]',
  replyText: 'text-sm leading-6',
  card: 'rounded-lg border border-black/[0.12] bg-white font-mono dark:border-white/[0.14] dark:bg-[#171717]',
  header: 'border-b border-black/[0.08] dark:border-white/[0.1]',
};

const GEMINI: Omit<ChatTheme, 'name'> = {
  surface: 'bg-white text-[#1f1f1f] dark:bg-[#131314] dark:text-[#e3e3e3]',
  accentText:
    'bg-gradient-to-r from-[#4285f4] via-[#9b72cb] to-[#d96570] bg-clip-text text-transparent',
  accentButton:
    'bg-gradient-to-r from-[#4285f4] via-[#9b72cb] to-[#d96570] text-white hover:brightness-110',
  glow: 'bg-gradient-to-br from-[#4285f4]/20 via-[#9b72cb]/20 to-[#d96570]/20 shadow-[0_0_56px_-10px_#9b72cbaa]',
  userBubble:
    'rounded-3xl rounded-tr-md bg-[#e9eef6] text-[#1f1f1f] dark:bg-[#282a2c] dark:text-[#e3e3e3]',
  replyText: 'text-[15px] leading-7',
  card: 'rounded-2xl border border-[#c4c7c5]/60 bg-[#f8fafd] dark:border-[#444746] dark:bg-[#1e1f20]',
  header: 'border-b border-[#c4c7c5]/50 dark:border-[#444746]/70',
};

const THEMES: Record<string, Omit<ChatTheme, 'name'>> = {
  'claude-code': CLAUDE,
  openclaude: CLAUDE,
  'codex-cli': CODEX,
  'gemini-cli': GEMINI,
  'qwen-cli': GEMINI,
};

export function chatThemeFor(cliId: string | undefined): ChatTheme {
  const cli = CLI_REGISTRY.find((one) => one.id === cliId);
  const name = cli?.label ?? cli?.name ?? 'Agent';
  return { name, ...(THEMES[cliId ?? ''] ?? CODEX) };
}
