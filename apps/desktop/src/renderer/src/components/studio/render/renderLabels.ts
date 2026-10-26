import type { Codec, Quality, RenderJobView, RenderStatus, Resolution } from '@runova/studio';
import type { ChipTone } from '../kit';

/** How the render dialog and the render list name each setting. */

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  '720p': '720p',
  '1080p': '1080p',
  '1440p': '1440p',
  '2160p': '4K',
};

export const QUALITY_LABELS: Record<Quality, string> = {
  draft: 'Draft',
  standard: 'Standard',
  high: 'High',
  master: 'Master',
};

export const QUALITY_HINTS: Record<Quality, string> = {
  draft: 'Small and quick, to check timing and flow',
  standard: 'Good for sharing and most sites',
  high: 'Sharper fine detail and text, a larger file',
  master: 'Close to lossless, for editing further or archiving',
};

export const CODEC_LABELS: Record<Codec, string> = {
  h264: 'H.264',
  h265: 'H.265',
  vp9: 'VP9',
};

export const CODEC_HINTS: Record<Codec, string> = {
  h264: 'MP4 that plays everywhere',
  h265: 'MP4 about half the size of H.264, for newer players',
  vp9: 'WebM for the web',
};

export const STATUS_CHIPS: Record<RenderStatus, { label: string; tone: ChipTone }> = {
  queued: { label: 'Waiting', tone: 'neutral' },
  running: { label: 'Rendering', tone: 'primary' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'destructive' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  interrupted: { label: 'Stopped', tone: 'warning' },
};

/** "Drawing frames: 120 of 300", "Encoding: 45 of 270 frames", or "Waiting for another render". */
export function progressLabel(job: RenderJobView): string {
  if (job.status === 'queued') return 'Waiting for the render before it to finish';
  if (job.phase === 'encode') return `Encoding: ${job.done} of ${job.total} frames`;
  if (job.phase === 'capture') return `Drawing frames: ${job.done} of ${job.total}`;
  return 'Starting';
}

/** Whether a render is still to come or under way. */
export function isActive(job: RenderJobView): boolean {
  return job.status === 'queued' || job.status === 'running';
}
