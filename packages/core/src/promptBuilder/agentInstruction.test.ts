import { describe, expect, it } from 'vitest';
import { buildAgentInstructionRequest } from './agentInstruction.js';

/**
 * "Write it for me" in the AI task boxes sends this to the user's AI provider, which turns a rough
 * note (often Persian, often half a sentence) into the instruction the terminal or desktop agent
 * reads. What the user typed is the only thing inserted verbatim.
 */

describe('buildAgentInstructionRequest', () => {
  it('asks for a task for a server when starting one over SSH', () => {
    const request = buildAgentInstructionRequest({
      text: 'disk full? clean logs',
      purpose: 'task',
      target: 'ssh',
    });
    expect(request).toContain('a remote server over SSH');
    expect(request).toContain('the task the user wants done');
    expect(request).toContain('"""\ndisk full? clean logs\n"""');
  });

  it('names this computer for a local terminal and the desktop for Remote Desktop', () => {
    expect(buildAgentInstructionRequest({ text: 'x', purpose: 'task', target: 'local' })).toContain(
      "a shell on the user's own computer",
    );
    expect(buildAgentInstructionRequest({ text: 'x', purpose: 'task', target: 'rdp' })).toContain(
      'a Remote Desktop session',
    );
  });

  it('frames a mid-run message as a correction to work already under way', () => {
    const request = buildAgentInstructionRequest({
      text: 'not that folder',
      purpose: 'message',
      target: 'ssh',
    });
    expect(request).toContain('already working');
    expect(request).not.toContain('The agent asked');
  });

  it('includes the question when the text answers one', () => {
    const request = buildAgentInstructionRequest({
      text: 'the second one',
      purpose: 'answer',
      target: 'ssh',
      question: 'Which nginx site should I reload?',
    });
    expect(request).toContain('The agent asked:\n"""\nWhich nginx site should I reload?\n"""');
    expect(request).toContain('answer');
  });

  it('keeps Persian text exactly as typed and asks for English back', () => {
    const text = 'لاگ‌های قدیمی را پاک کن';
    const request = buildAgentInstructionRequest({
      text: `  ${text}\n`,
      purpose: 'task',
      target: 'ssh',
    });
    expect(request).toContain(`"""\n${text}\n"""`);
    expect(request).toContain('in clear English');
  });

  it('asks to keep commands, paths and names verbatim and to answer with the text alone', () => {
    const request = buildAgentInstructionRequest({ text: 'x', purpose: 'task', target: 'ssh' });
    expect(request).toContain('verbatim');
    expect(request).toContain('Output ONLY');
  });
});
