import { flicksToSeconds, secondsToFlicks } from '@agentmat/studio';

/** A service error in plain words, without Electron's "Error invoking remote method" prefix. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['week', 7 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
];

/** "5 minutes ago", "yesterday", "just now". */
export function formatWhen(at: number, now = Date.now()): string {
  const diff = at - now;
  for (const [unit, size] of STEPS) {
    if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit);
  }
  return 'just now';
}

/** A scene length for a field: whole seconds stay whole, the rest get one decimal. */
export function flicksToFieldSeconds(flicks: number): string {
  const seconds = flicksToSeconds(flicks);
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

/** Reads a typed length in seconds, or null when it is not a usable length (0.5 s to 10 min). */
export function fieldSecondsToFlicks(text: string): number | null {
  const seconds = Number(text.trim().replace(',', '.'));
  if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 600) return null;
  return secondsToFlicks(Math.round(seconds * 10) / 10);
}

/** Persian text in a field gets the app's Persian font; the field's direction follows its text. */
export function scriptClass(text: string): string | undefined {
  return /[؀-ۿ]/.test(text) ? 'font-vazirmatn' : undefined;
}
