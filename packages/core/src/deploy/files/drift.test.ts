import { describe, expect, it } from 'vitest';
import { detectUniformShift, judgeRemote } from './drift.js';
import type { BaseEntry, RemoteObservation, RemoteTimeSource } from './types.js';

const HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 1, 12, 0, 0);

function obs(
  size: number,
  mtimeMs: number | null = T,
  via: RemoteTimeSource | null = 'sftp',
): RemoteObservation {
  return { size, mtimeMs, via };
}

function base(remote: RemoteObservation | null, size = remote?.size ?? 10): BaseEntry {
  return { sha256: 'a'.repeat(64), size, localMtimeMs: T - 1000, remote };
}

describe('judgeRemote', () => {
  it.each<[string, BaseEntry | undefined, RemoteObservation | undefined, boolean, string]>([
    ['not in the base, on the server', undefined, obs(10), true, 'untracked'],
    ['not in the base, on the server, folder not listed', undefined, obs(10), false, 'untracked'],
    ['not in the base, folder listed, not there', undefined, undefined, true, 'missing'],
    ['not in the base, folder not listed', undefined, undefined, false, 'unknown'],
    ['in the base, folder not listed', base(obs(10)), undefined, false, 'unknown'],
    ['in the base, folder not listed, observed anyway', base(obs(10)), obs(10), false, 'unknown'],
    ['in the base, folder listed, gone', base(obs(10)), undefined, true, 'missing'],
    ['a different size', base(obs(10)), obs(11), true, 'changed'],
    ['a different size, time equal', base(obs(10, T)), obs(11, T), true, 'changed'],
    ['same size and time from the same source', base(obs(10)), obs(10), true, 'unchanged'],
    [
      'same size and time over MLSD',
      base(obs(10, T, 'mlsd')),
      obs(10, T, 'mlsd'),
      true,
      'unchanged',
    ],
    ['same size, later time, same source', base(obs(10)), obs(10, T + 1000), true, 'changed'],
    ['same size, earlier time, same source', base(obs(10)), obs(10, T - 1), true, 'changed'],
    [
      'same size, times from different sources',
      base(obs(10, T, 'mlsd')),
      obs(10, T, 'mdtm'),
      true,
      'sizeOnly',
    ],
    ['same size, no time now', base(obs(10)), obs(10, null, null), true, 'sizeOnly'],
    ['same size, no time then', base(obs(10, null, null)), obs(10), true, 'sizeOnly'],
    [
      'same size, a time with no source',
      base(obs(10, T, null)),
      obs(10, T, null),
      true,
      'sizeOnly',
    ],
    ['nothing read after the upload, same size as sent', base(null, 10), obs(10), true, 'sizeOnly'],
    ['nothing read after the upload, other size', base(null, 10), obs(12), true, 'changed'],
  ])('%s: %s', (_label, baseEntry, current, listed, verdict) => {
    expect(judgeRemote(baseEntry, current, listed)).toBe(verdict);
  });

  it("compares the server's size with what the server reported, not with what was sent", () => {
    // An FTP server in ASCII mode, or one that rewrites line endings, reports another size.
    const entry: BaseEntry = { ...base(obs(12)), size: 10 };
    expect(judgeRemote(entry, obs(12), true)).toBe('unchanged');
    expect(judgeRemote(entry, obs(10), true)).toBe('changed');
  });
});

describe('detectUniformShift', () => {
  const pair = (hours: number, size = 10, via: RemoteTimeSource = 'mlsd', at = T) => ({
    base: obs(size, at, via),
    current: obs(size, at + hours * HOUR, via),
  });

  it('finds a whole-hour shift shared by every pair', () => {
    expect(detectUniformShift([pair(1), pair(1, 20, 'mlsd', T - 5 * HOUR)])).toBe(1);
    expect(detectUniformShift([pair(-2), pair(-2), pair(-2)])).toBe(-2);
    expect(detectUniformShift([pair(26), pair(26)])).toBe(26);
    expect(detectUniformShift([pair(-26), pair(-26)])).toBe(-26);
  });

  it.each<[string, ReturnType<typeof pair>[]]>([
    ['no pairs', []],
    ['a single pair', [pair(1)]],
    ['no shift at all', [pair(0), pair(0)]],
    ['different shifts', [pair(1), pair(2)]],
    ['more than 26 hours', [pair(27), pair(27)]],
    ['less than -26 hours', [pair(-27), pair(-27)]],
    ['half an hour', [pair(0.5), pair(0.5)]],
    ['an hour and a second', [pair(1 + 1 / 3600), pair(1 + 1 / 3600)]],
  ])('none for %s', (_label, pairs) => {
    expect(detectUniformShift(pairs)).toBeNull();
  });

  it('none when a size differs', () => {
    expect(
      detectUniformShift(
        [pair(1), { base: obs(10, T), current: obs(11, T + HOUR) }].map((p) => ({
          base: { ...p.base, via: 'mlsd' as const },
          current: { ...p.current, via: 'mlsd' as const },
        })),
      ),
    ).toBeNull();
  });

  it('none when the times cannot be compared', () => {
    expect(
      detectUniformShift([
        pair(1),
        { base: obs(10, T, 'mlsd'), current: obs(10, T + HOUR, 'mdtm') },
      ]),
    ).toBeNull();
    expect(
      detectUniformShift([pair(1), { base: obs(10, null, null), current: obs(10, T + HOUR) }]),
    ).toBeNull();
    expect(
      detectUniformShift([pair(1), { base: obs(10, T, null), current: obs(10, T + HOUR, null) }]),
    ).toBeNull();
  });
});
