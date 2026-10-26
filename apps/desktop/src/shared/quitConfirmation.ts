import type { OpenSessionSummary } from './apiTypes';

export const QUIT_CONFIRM_TITLE = 'Close Runova?';
export const QUIT_CONFIRM_LABEL = 'Close app';

export function hasOpenSessions(summary: OpenSessionSummary): boolean {
  return summary.clis + summary.ssh + summary.rdp > 0;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The body of the close confirmation, shared by the app's dialog and the native fallback. */
export function describeOpenSessions(summary: OpenSessionSummary): string {
  const open: string[] = [];
  if (summary.clis > 0) open.push(plural(summary.clis, 'CLI session', 'CLI sessions'));
  if (summary.ssh > 0) open.push(plural(summary.ssh, 'SSH connection', 'SSH connections'));
  if (summary.rdp > 0) {
    open.push(plural(summary.rdp, 'Remote Desktop session', 'Remote Desktop sessions'));
  }

  const lines = [`You still have ${joinList(open)} open.`];
  const servers = summary.ssh + summary.rdp;
  const them = summary.clis + servers === 1 ? 'it' : 'them';
  if (summary.clis > 0 && summary.clisKeepRunning) {
    lines.push(
      servers > 0
        ? 'CLI sessions keep running in the background, but server connections will be closed.'
        : `Closing the app leaves ${them} running in the background, ready when you open it again.`,
    );
  } else if (summary.clis > 0 && servers > 0) {
    lines.push('Closing the app stops the CLI sessions and disconnects from every server.');
  } else if (summary.clis > 0) {
    lines.push(`Closing the app stops ${them}.`);
  } else {
    lines.push(`Closing the app disconnects ${them}.`);
  }
  return lines.join('\n');
}
