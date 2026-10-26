/**
 * Drag and drop between the SFTP file manager's panes (E25). A row drag carries its paths as
 * JSON under `SFTP_DND_MIME`; a second, empty type names the pane it came from, because a page
 * can only read a drag's types (not its data) until the drop itself, and the panes need to know
 * the source while the pointer is still moving.
 */

export const SFTP_DND_MIME = 'application/x-runova-sftp';
const SIDE_MIME = {
  local: 'application/x-runova-sftp-local',
  remote: 'application/x-runova-sftp-remote',
} as const;

export type DragSide = 'local' | 'remote';

export interface SftpDragPayload {
  serverId: string;
  side: DragSide;
  paths: string[];
}

/** The part of a DataTransfer these helpers use, so tests can pass a plain object. */
export interface DragData {
  readonly types: readonly string[] | DOMStringList;
  effectAllowed: string;
  setData(type: string, value: string): void;
  getData(type: string): string;
}

export type DragKind = { type: 'rows'; side: DragSide } | { type: 'files' };

function typesOf(data: Pick<DragData, 'types'>): string[] {
  return Array.from(data.types as ArrayLike<string>);
}

export function writeDragPayload(data: DragData, payload: SftpDragPayload): void {
  data.effectAllowed = 'copy';
  data.setData(SFTP_DND_MIME, JSON.stringify(payload));
  data.setData(SIDE_MIME[payload.side], '');
  data.setData('text/plain', payload.paths.join('\n'));
}

/** The payload of a row drag, on drop. Null when the drag is not one or does not parse. */
export function readDragPayload(data: Pick<DragData, 'getData'>): SftpDragPayload | null {
  const raw = data.getData(SFTP_DND_MIME);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SftpDragPayload>;
    if (
      typeof value.serverId !== 'string' ||
      (value.side !== 'local' && value.side !== 'remote') ||
      !Array.isArray(value.paths) ||
      !value.paths.every((path) => typeof path === 'string')
    ) {
      return null;
    }
    return { serverId: value.serverId, side: value.side, paths: value.paths };
  } catch {
    return null;
  }
}

/** What is being dragged, from the types alone: rows from a pane, OS files, or nothing of ours. */
export function dragKind(data: Pick<DragData, 'types'>): DragKind | null {
  const types = typesOf(data);
  if (types.includes(SFTP_DND_MIME)) {
    if (types.includes(SIDE_MIME.local)) return { type: 'rows', side: 'local' };
    if (types.includes(SIDE_MIME.remote)) return { type: 'rows', side: 'remote' };
    return null;
  }
  if (types.includes('Files')) return { type: 'files' };
  return null;
}
