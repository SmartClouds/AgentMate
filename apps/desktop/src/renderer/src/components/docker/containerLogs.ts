import type { DockerLogLine } from '@shared/apiTypes';
import { plain } from '@/lib/deploy/containers/logs';

/**
 * A container's log as plain text, for the clipboard or a file: one line each, the full time in
 * front unless left out, stderr marked in words, and terminal colour codes taken out.
 */
export function logAsText(
  lines: readonly DockerLogLine[],
  { timestamps = true }: { timestamps?: boolean } = {},
): string {
  return lines
    .map((line) => {
      const stream = line.stream === 'stderr' ? '[stderr] ' : '';
      const text = `${stream}${plain(line.text)}`;
      return timestamps ? `${line.timestamp} ${text}` : text;
    })
    .join('\n');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** "web-logs-2026-10-29-080509.log", in this computer's time. */
export function logFileName(containerName: string, at: Date): string {
  const name = containerName.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'container';
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${name}-logs-${date}-${time}.log`;
}
