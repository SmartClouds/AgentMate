import { formatBytes } from '@/lib/format';

export type RdpLinkLevel = 'excellent' | 'good' | 'fair' | 'poor';

export interface RdpLinkQuality {
  level: RdpLinkLevel;
  /** How many of the four signal bars are lit. */
  bars: 1 | 2 | 3 | 4;
  label: string;
}

/**
 * How the connection feels, from how long the server takes to react to input. Remote work stays
 * smooth up to roughly 75 ms, is still fine to 150 ms, drags noticeably past 300 ms.
 */
export function linkQuality(latencyMs: number | null): RdpLinkQuality | null {
  if (latencyMs === null) return null;
  if (latencyMs <= 75) return { level: 'excellent', bars: 4, label: 'Excellent' };
  if (latencyMs <= 150) return { level: 'good', bars: 3, label: 'Good' };
  if (latencyMs <= 300) return { level: 'fair', bars: 2, label: 'Fair' };
  return { level: 'poor', bars: 1, label: 'Poor' };
}

/** "0 B/s", "412 KB/s", "1.21 MB/s". */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}
