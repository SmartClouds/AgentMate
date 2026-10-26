export interface VaultTimerSettings {
  vaultAutoLockMinutes: number;
  vaultClipboardClearSeconds: number;
}

export interface VaultTimers {
  autoLockMs: number | null;
  clipboardClearMs: number | null;
  backoffBaseMs: number;
}

export const VAULT_TEST_TIMERS_ENV = 'RUNOVA_VAULT_TEST_TIMERS';
const DEFAULT_BACKOFF_BASE_MS = 1000;
const MIN_OVERRIDE_MS = 200;

/**
 * Settings in milliseconds. End-to-end tests can shorten the timers with
 * RUNOVA_VAULT_TEST_TIMERS="autoLockMs=4000,clipboardMs=2000,backoffBaseMs=300", but only in
 * an unpackaged build, so an installed app can't be talked out of locking by its environment.
 */
export function resolveVaultTimers(
  settings: VaultTimerSettings,
  env: Record<string, string | undefined>,
  isPackaged: boolean,
): VaultTimers {
  const timers: VaultTimers = {
    autoLockMs: settings.vaultAutoLockMinutes > 0 ? settings.vaultAutoLockMinutes * 60_000 : null,
    clipboardClearMs:
      settings.vaultClipboardClearSeconds > 0 ? settings.vaultClipboardClearSeconds * 1000 : null,
    backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
  };
  const override = env[VAULT_TEST_TIMERS_ENV];
  if (isPackaged || !override) return timers;

  for (const pair of override.split(',')) {
    const [key, raw] = pair.split('=');
    const value = Number(raw);
    if (raw === undefined || !Number.isFinite(value)) continue;
    const ms = Math.max(MIN_OVERRIDE_MS, Math.round(value));
    if (key === 'autoLockMs') timers.autoLockMs = ms;
    else if (key === 'clipboardMs') timers.clipboardClearMs = ms;
    else if (key === 'backoffBaseMs') timers.backoffBaseMs = ms;
  }
  return timers;
}
