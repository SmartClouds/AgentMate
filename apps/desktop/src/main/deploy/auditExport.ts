import type { AuditEventInfo } from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployAuditFilter } from '../../shared/deploySecurityTypes';

/**
 * A server core's audit trail as a file: CSV for a spreadsheet, JSON for another tool. Names,
 * targets and parameters come from whoever called the core, so in CSV every cell is quoted when it
 * has to be, and one that a spreadsheet would read as a formula gets a leading apostrophe.
 */

const COLUMNS = [
  'id',
  'time',
  'actor',
  'actorId',
  'device',
  'deviceId',
  'peerUid',
  'action',
  'target',
  'result',
  'parameters',
] as const;

/** What Excel, LibreOffice and Sheets start a formula with (OWASP's CSV injection list). */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

function cell(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const iso = (unixMs: number): string => new Date(unixMs).toISOString();

export function auditCsv(events: readonly AuditEventInfo[]): string {
  const rows = events.map((event) =>
    [
      event.id,
      iso(event.atUnixMs),
      event.actorUserName,
      event.actorUserId,
      event.deviceName,
      event.deviceId,
      event.peerUid,
      event.action,
      event.target,
      event.result,
      event.parameters,
    ]
      .map(cell)
      .join(','),
  );
  return `${[COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}

export interface AuditJsonMeta {
  server: string;
  exportedAtUnixMs: number;
  filter: DeployAuditFilter;
  truncated: boolean;
}

export function auditJson(events: readonly AuditEventInfo[], meta: AuditJsonMeta): string {
  return JSON.stringify(
    {
      server: meta.server,
      exportedAt: iso(meta.exportedAtUnixMs),
      filter: meta.filter,
      truncated: meta.truncated,
      events: events.map((event) => ({ ...event, time: iso(event.atUnixMs) })),
    },
    null,
    2,
  );
}
