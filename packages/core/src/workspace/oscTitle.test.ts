import { describe, expect, it } from 'vitest';
import { agentSessionTitle, cleanTerminalTitle, OscTitleParser } from './oscTitle.js';

describe('OscTitleParser', () => {
  it('reads BEL and ST terminated titles', () => {
    const parser = new OscTitleParser();
    expect(parser.push('hello\x1b]0;first\x07world')).toBe('first');
    expect(parser.push('\x1b]2;second\x1b\\')).toBe('second');
  });

  it('returns the last title in a chunk and ignores other OSC codes', () => {
    const parser = new OscTitleParser();
    expect(parser.push('\x1b]0;a\x07\x1b]8;;http://x\x07\x1b]2;b\x07')).toBe('b');
    expect(parser.push('\x1b]7;file://host/dir\x07')).toBeNull();
  });

  it('joins sequences split across chunks', () => {
    const parser = new OscTitleParser();
    expect(parser.push('output\x1b')).toBeNull();
    expect(parser.push(']0;spl')).toBeNull();
    expect(parser.push('it\x07more')).toBe('split');
  });

  it('cleans spinner prefixes and control characters', () => {
    expect(cleanTerminalTitle('✳ Fix login bug')).toEqual({
      title: 'Fix login bug',
      spinning: true,
    });
    expect(cleanTerminalTitle('/home/me')).toEqual({ title: '/home/me', spinning: false });
  });
});

describe('agentSessionTitle', () => {
  it('keeps a title that describes the task', () => {
    expect(agentSessionTitle('Fix login bug', 'Claude Code')).toBe('Fix login bug');
    expect(agentSessionTitle('  Add npm scripts ', 'Codex CLI')).toBe('Add npm scripts');
  });

  it("drops OpenCode's OC | prefix and keeps the session title", () => {
    expect(agentSessionTitle('OC | Fix login bug', 'OpenCode')).toBe('Fix login bug');
    expect(agentSessionTitle('OC |  Spaced out', 'OpenCode')).toBe('Spaced out');
    expect(agentSessionTitle('OC | Debugging OpenCode Gemini CLI tra…', 'OpenCode')).toBe(
      'Debugging OpenCode Gemini CLI tra…',
    );
  });

  it('treats an OpenCode title with nothing after the prefix as no title', () => {
    expect(agentSessionTitle('OC |', 'OpenCode')).toBeNull();
    expect(agentSessionTitle('OC | ', 'OpenCode')).toBeNull();
    expect(agentSessionTitle('OpenCode', 'OpenCode')).toBeNull();
  });

  it('ignores the CLI name and what the shell set before it', () => {
    expect(agentSessionTitle(undefined, 'Claude Code')).toBeNull();
    expect(agentSessionTitle('', 'Claude Code')).toBeNull();
    expect(agentSessionTitle('Claude Code', 'Claude Code')).toBeNull();
    expect(agentSessionTitle('claude', 'Claude Code')).toBeNull();
    expect(agentSessionTitle('C:\WINDOWS\system32\cmd.exe - claude', 'Claude Code')).toBeNull();
    expect(agentSessionTitle('/home/me/project', 'Codex CLI')).toBeNull();
    expect(agentSessionTitle('~/project', 'Codex CLI')).toBeNull();
    expect(agentSessionTitle('Windows PowerShell', 'Claude Code')).toBeNull();
    expect(agentSessionTitle('pwsh', 'Claude Code')).toBeNull();
  });
});
