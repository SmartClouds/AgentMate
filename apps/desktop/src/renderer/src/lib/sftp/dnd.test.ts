import { describe, expect, it } from 'vitest';
import {
  dragKind,
  readDragPayload,
  SFTP_DND_MIME,
  type SftpDragPayload,
  writeDragPayload,
} from './dnd';

/** jsdom has no DataTransfer, so a small one that behaves like Chromium's. */
function fakeTransfer(files: File[] = []) {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    files,
    get types() {
      return [...data.keys(), ...(files.length > 0 ? ['Files'] : [])];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  };
}

const payload: SftpDragPayload = {
  serverId: 'srv-1',
  side: 'remote',
  paths: ['/srv/a.txt', '/srv/site'],
};

describe('the row drag payload', () => {
  it('rides on the custom MIME type with a plain text copy of the paths', () => {
    const transfer = fakeTransfer();
    writeDragPayload(transfer, payload);
    expect(transfer.types).toContain(SFTP_DND_MIME);
    expect(transfer.getData('text/plain')).toBe('/srv/a.txt\n/srv/site');
    expect(transfer.effectAllowed).toBe('copy');
    expect(readDragPayload(transfer)).toEqual(payload);
  });

  it('reads nothing from a drag without it, or with a damaged one', () => {
    expect(readDragPayload(fakeTransfer())).toBeNull();
    const broken = fakeTransfer();
    broken.setData(SFTP_DND_MIME, '{not json');
    expect(readDragPayload(broken)).toBeNull();
    const wrongShape = fakeTransfer();
    wrongShape.setData(SFTP_DND_MIME, JSON.stringify({ side: 'remote', paths: 'x' }));
    expect(readDragPayload(wrongShape)).toBeNull();
  });
});

describe('dragKind', () => {
  it('tells a row drag from each pane apart without reading its data', () => {
    const fromRemote = fakeTransfer();
    writeDragPayload(fromRemote, payload);
    expect(dragKind(fromRemote)).toEqual({ type: 'rows', side: 'remote' });

    const fromLocal = fakeTransfer();
    writeDragPayload(fromLocal, { ...payload, side: 'local', paths: ['C:\\a.txt'] });
    expect(dragKind(fromLocal)).toEqual({ type: 'rows', side: 'local' });
  });

  it('knows OS files and ignores everything else', () => {
    expect(dragKind(fakeTransfer([new File(['x'], 'a.txt')]))).toEqual({ type: 'files' });
    const text = fakeTransfer();
    text.setData('text/plain', 'hello');
    expect(dragKind(text)).toBeNull();
  });
});
