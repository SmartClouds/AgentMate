import { describe, expect, it } from 'vitest';
import type { AuditEventInfo } from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { auditCsv, auditJson } from './auditExport';

/**
 * An audit export someone opens in a spreadsheet or feeds to another tool. User names, targets
 * and parameters come from whoever called the core, so a cell must never turn into a formula and
 * a comma or quote must never shift a column.
 */

const EVENT: AuditEventInfo = {
  id: 42,
  atUnixMs: Date.UTC(2026, 9, 1, 9, 30, 0),
  actorUserId: '11111111-2222-4333-8444-555555555555',
  actorUserName: 'maria',
  deviceId: '66666666-7777-4888-9999-000000000000',
  deviceName: 'Maria-PC',
  action: 'user.create',
  target: 'sam',
  parameters: '{"role":"operator"}',
  result: 'success',
};

describe('auditCsv', () => {
  it('writes a header and one row per event, with the time in UTC', () => {
    const csv = auditCsv([EVENT]);
    const [header, row] = csv.trimEnd().split('\r\n');

    expect(header).toBe(
      'id,time,actor,actorId,device,deviceId,peerUid,action,target,result,parameters',
    );
    expect(row).toBe(
      '42,2026-10-01T09:30:00.000Z,maria,11111111-2222-4333-8444-555555555555,Maria-PC,66666666-7777-4888-9999-000000000000,,user.create,sam,success,"{""role"":""operator""}"',
    );
  });

  it('quotes commas, quotes and line breaks so no column shifts', () => {
    const csv = auditCsv([{ ...EVENT, target: 'a, "b"\nc', parameters: undefined }]);

    expect(csv).toContain(',"a, ""b""\nc",success,\r\n');
  });

  it('keeps a cell from starting a formula', () => {
    const csv = auditCsv([
      { ...EVENT, target: '=HYPERLINK("http://x")', actorUserName: '+1', deviceName: '@me' },
      { ...EVENT, target: '-2+3', actorUserName: '\tTAB', deviceName: undefined },
    ]);
    const rows = csv.trimEnd().split('\r\n').slice(1);

    expect(rows[0]).toContain(`'+1,`);
    expect(rows[0]).toContain(`'@me,`);
    expect(rows[0]).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(rows[1]).toContain(`'-2+3`);
    expect(rows[1]).toContain(`'\tTAB`);
  });

  it('writes only the header when nothing matched', () => {
    expect(auditCsv([])).toBe(
      'id,time,actor,actorId,device,deviceId,peerUid,action,target,result,parameters\r\n',
    );
  });
});

describe('auditJson', () => {
  it('keeps every event as the core sent it, with the server, the filter and the time of export', () => {
    const json = JSON.parse(
      auditJson([EVENT], {
        server: 'Production',
        exportedAtUnixMs: Date.UTC(2026, 9, 1, 10, 0, 0),
        filter: { result: 'success' },
        truncated: false,
      }),
    ) as Record<string, unknown>;

    expect(json).toEqual({
      server: 'Production',
      exportedAt: '2026-10-01T10:00:00.000Z',
      filter: { result: 'success' },
      truncated: false,
      events: [{ ...EVENT, time: '2026-10-01T09:30:00.000Z' }],
    });
  });
});
