import type { DockerLogLine } from '@shared/apiTypes';
import { describe, expect, it } from 'vitest';
import { logAsText, logFileName } from './containerLogs';

function line(overrides: Partial<DockerLogLine>): DockerLogLine {
  return {
    stream: 'stdout',
    timestamp: '2024-05-01T10:00:00.000000000Z',
    atUnixMs: Date.parse('2024-05-01T10:00:00.000Z'),
    text: '',
    ...overrides,
  };
}

describe('logAsText', () => {
  it('writes one line per entry with its full time, and marks what came from stderr', () => {
    const text = logAsText([
      line({ text: 'listening on :8080' }),
      line({ stream: 'stderr', timestamp: '2024-05-01T10:00:01.500000000Z', text: 'db down' }),
    ]);

    expect(text).toBe(
      '2024-05-01T10:00:00.000000000Z listening on :8080\n' +
        '2024-05-01T10:00:01.500000000Z [stderr] db down',
    );
  });

  it('takes out terminal colour codes, which are noise in a saved file', () => {
    expect(logAsText([line({ text: '\u001b[32mGET /\u001b[0m 200' })])).toBe(
      '2024-05-01T10:00:00.000000000Z GET / 200',
    );
  });

  it('can leave the times out, for pasting just what the program printed', () => {
    expect(
      logAsText([line({ text: 'a' }), line({ stream: 'stderr', text: 'b' })], {
        timestamps: false,
      }),
    ).toBe('a\n[stderr] b');
  });
});

describe('logFileName', () => {
  it('names the file after the container and the local time it was saved', () => {
    expect(logFileName('shop-web-1', new Date(2026, 9, 29, 8, 5, 9))).toBe(
      'shop-web-1-logs-2026-10-29-080509.log',
    );
  });

  it('keeps characters a file name cannot hold out of it', () => {
    expect(logFileName('a/b:c*?', new Date(2026, 0, 2, 3, 4, 5))).toBe(
      'a-b-c-logs-2026-01-02-030405.log',
    );
  });
});
