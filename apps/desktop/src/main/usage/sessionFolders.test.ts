import { describe, expect, it } from 'vitest';
import {
  codexCwdFromHead,
  cwdFromLine,
  cwdsIn,
  encodeClaudeDir,
  launchFolder,
  topLevelDir,
} from './sessionFolders';

/**
 * Where a session ran, read off its transcript. Claude Code names a project directory after the
 * folder it was launched in, so the launch folder is recovered by encoding cwds the sessions wrote.
 */

const cwdLine = (cwd: string): string => JSON.stringify({ type: 'user', cwd });

describe('encodeClaudeDir', () => {
  it('turns every character that is not a letter or a digit into a dash', () => {
    expect(encodeClaudeDir('E:\\Runova')).toBe('E--Runova');
    expect(encodeClaudeDir('/home/me/my_app.v2')).toBe('-home-me-my-app-v2');
    expect(encodeClaudeDir('C:\\Users\\Ann Lee\\repo')).toBe('C--Users-Ann-Lee-repo');
  });

  it('keeps the length, so a prefix of a folder encodes to a prefix of its name', () => {
    const folder = 'E:\\Work\\app-2';
    const dir = encodeClaudeDir(folder);
    expect(dir).toHaveLength(folder.length);
    expect(encodeClaudeDir(folder.slice(0, 9))).toBe(dir.slice(0, 9));
  });

  it('gives a drive root two dashes, the way Claude Code names it', () => {
    expect(encodeClaudeDir('E:\\')).toBe('E--');
  });

  it('gives a non-ASCII letter one dash, and an astral character two', () => {
    expect(encodeClaudeDir('Café')).toBe('Caf-');
    expect(encodeClaudeDir('a😀b')).toBe('a--b');
  });
});

describe('cwdFromLine', () => {
  it('reads and unescapes the cwd on a JSON line', () => {
    expect(cwdFromLine(cwdLine('C:\\Users\\Ann\\repo'))).toBe('C:\\Users\\Ann\\repo');
  });

  it('returns null when the line has no cwd, or an empty one', () => {
    expect(cwdFromLine('{"type":"user"}')).toBeNull();
    expect(cwdFromLine('{"cwd":""}')).toBeNull();
  });

  it('ignores a cwd that only appears inside message text', () => {
    const line = JSON.stringify({ message: { content: 'the key is "cwd":"/x"' } });
    expect(cwdFromLine(line)).toBeNull();
  });

  it('returns null for an invalid escape instead of throwing', () => {
    // `\q` is not a JSON escape, so the value cannot be decoded.
    expect(cwdFromLine('{"cwd":"E:\\q"}')).toBeNull();
  });
});

describe('cwdsIn', () => {
  it('returns the distinct cwds in order, up to the limit', () => {
    const lines = [
      cwdLine('E:\\A'),
      'not json, no cwd',
      cwdLine('E:\\A'),
      cwdLine('E:\\A\\src'),
      cwdLine('E:\\B'),
    ];
    expect(cwdsIn(lines)).toEqual(['E:\\A', 'E:\\A\\src', 'E:\\B']);
    expect(cwdsIn(lines, 2)).toEqual(['E:\\A', 'E:\\A\\src']);
  });
});

describe('launchFolder', () => {
  it('returns the folder itself when a cwd is exactly that folder', () => {
    expect(launchFolder('E--Runova', ['E:\\Runova'])).toBe('E:\\Runova');
  });

  it('recovers the launch folder from a cwd the session moved into', () => {
    expect(launchFolder('E--Runova', ['E:\\Runova\\apps\\desktop\\src'])).toBe('E:\\Runova');
  });

  it('does not match a sibling folder that only shares the start of its name', () => {
    expect(launchFolder('E--Runova', ['E:\\Runova2'])).toBeNull();
  });

  it('matches the drive letter whatever its case', () => {
    expect(launchFolder('e--Runova', ['E:\\Runova\\x'])).toBe('E:\\Runova');
  });

  it('moves on to a later sample when an earlier one does not fit', () => {
    expect(launchFolder('E--Runova', ['E:\\Other\\deep', 'E:\\Runova\\x'])).toBe('E:\\Runova');
  });

  it('handles a launch at a drive root, whose name ends in dashes', () => {
    expect(launchFolder('E--', ['E:\\Runova\\apps'])).toBe('E:\\');
    expect(launchFolder('E--', ['E:\\'])).toBe('E:\\');
  });

  it('handles POSIX folders', () => {
    expect(launchFolder('-home-me-app', ['/home/me/app/src'])).toBe('/home/me/app');
  });

  it('handles folder names with spaces, underscores and dots', () => {
    const folder = 'C:\\Users\\Ann Lee\\my_repo.v2';
    expect(launchFolder(encodeClaudeDir(folder), [`${folder}\\src`])).toBe(folder);
  });

  it('gives up on a name Claude shortened, so the caller can fall back', () => {
    expect(launchFolder('E--a-very-long-name-with-a-hash-1f3a', ['E:\\Runova'])).toBeNull();
  });

  it('gives up when there are no cwds at all', () => {
    expect(launchFolder('E--Runova', [])).toBeNull();
  });
});

describe('topLevelDir', () => {
  it('names the first folder under the root', () => {
    expect(topLevelDir('/root/projects', '/root/projects/E--app/abc.jsonl')).toBe('E--app');
  });

  it('finds the project folder of a subagent transcript as well', () => {
    expect(topLevelDir('/root/projects', '/root/projects/E--app/abc/subagents/agent-1.jsonl')).toBe(
      'E--app',
    );
  });

  it('returns null for a file that sits directly in the root', () => {
    expect(topLevelDir('/root/projects', '/root/projects/loose.jsonl')).toBeNull();
  });

  it('accepts a trailing separator on the root and Windows separators', () => {
    expect(topLevelDir('E:\\root\\projects\\', 'E:\\root\\projects\\E--app\\x.jsonl')).toBe(
      'E--app',
    );
  });
});

describe('codexCwdFromHead', () => {
  it('reads the folder from the session_meta line', () => {
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'x', cwd: 'E:\\MehrCare' },
    });
    expect(codexCwdFromHead([meta, '{"type":"event_msg"}'])).toBe('E:\\MehrCare');
  });

  it('falls back to a turn_context line', () => {
    const context = JSON.stringify({ type: 'turn_context', payload: { cwd: 'E:\\Galaxy\\docs' } });
    expect(codexCwdFromHead(['{"type":"event_msg"}', context])).toBe('E:\\Galaxy\\docs');
  });

  it('ignores a cwd on any other kind of line, such as an exec event in a subfolder', () => {
    const event = JSON.stringify({ type: 'event_msg', payload: { cwd: 'E:\\sub' } });
    expect(codexCwdFromHead([event])).toBeNull();
  });
});
