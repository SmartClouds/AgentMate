import { describe, expect, it } from 'vitest';
import { buildHeadlessImageInput, supportsPromptImages } from './headlessImages.js';
import { type CliDefinition, getCliDefinition } from './registry.js';

function cli(id: string): CliDefinition {
  const found = getCliDefinition(id);
  if (!found) throw new Error(`no ${id} in the registry`);
  return found;
}

/** A made-up entry, so each attach style can be pinned without depending on the registry values. */
function fake(overrides: Partial<CliDefinition>): CliDefinition {
  return { ...cli('claude-code'), ...overrides };
}

describe('supportsPromptImages', () => {
  it('is true for the CLIs that can look at a screenshot', () => {
    expect(supportsPromptImages(cli('claude-code'))).toBe(true);
    expect(supportsPromptImages(cli('codex-cli'))).toBe(true);
    expect(supportsPromptImages(cli('gemini-cli'))).toBe(true);
  });

  it('is false for the rest', () => {
    expect(supportsPromptImages(cli('opencode'))).toBe(false);
  });

  it('is false without a prompt command, whatever the image field says', () => {
    expect(supportsPromptImages(fake({ promptCommand: undefined, promptImageInput: 'flag' }))).toBe(
      false,
    );
  });
});

describe('buildHeadlessImageInput', () => {
  it('adds the per-image flags for Codex and leaves the prompt alone', () => {
    expect(buildHeadlessImageInput(cli('codex-cli'), ['frame.png'])).toEqual({
      // An image run's temp folder isn't a git repo, which `codex exec` refuses without this.
      args: ['--skip-git-repo-check', '--image', 'frame.png'],
      promptPrefix: '',
      env: {},
    });
  });

  it('repeats the image flag per image and the other args once', () => {
    expect(buildHeadlessImageInput(cli('codex-cli'), ['a.png', 'b.png']).args).toEqual([
      '--skip-git-repo-check',
      '--image',
      'a.png',
      '--image',
      'b.png',
    ]);
  });

  it('mentions the image in the prompt for Gemini and trusts the folder', () => {
    expect(buildHeadlessImageInput(cli('gemini-cli'), ['frame.png'])).toEqual({
      args: [],
      promptPrefix: '@frame.png ',
      env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    });
  });

  it('uses the bare path for a CLI whose mentions are plain', () => {
    const plain = fake({ promptImageInput: 'mention', fileMention: 'plain' });
    expect(buildHeadlessImageInput(plain, ['frame.png']).promptPrefix).toBe('frame.png ');
  });

  it('uses forward slashes and quotes a path with spaces in a mention', () => {
    const mention = fake({ promptImageInput: 'mention', promptImageEnv: undefined });
    expect(buildHeadlessImageInput(mention, ['shots\\my frame.png']).promptPrefix).toBe(
      '@"shots/my frame.png" ',
    );
  });

  it('lets Claude Code read the image and nothing else', () => {
    const input = buildHeadlessImageInput(cli('claude-code'), ['frame.png']);
    expect(input.args).toEqual(['--allowedTools', 'Read']);
    expect(input.env).toEqual({});
    expect(input.promptPrefix).toContain('Read tool');
    expect(input.promptPrefix).toContain('./frame.png');
    expect(input.promptPrefix.endsWith('\n\n')).toBe(true);
  });

  it('adds read-tool args once, however many images there are', () => {
    const input = buildHeadlessImageInput(cli('claude-code'), ['a.png', 'b.png']);
    expect(input.args).toEqual(['--allowedTools', 'Read']);
    expect(input.promptPrefix).toContain('./a.png');
    expect(input.promptPrefix).toContain('./b.png');
  });

  it('names an absolute image as it is and opens its folder to Claude Code', () => {
    const input = buildHeadlessImageInput(cli('claude-code'), [
      'C:\\Temp\\attach\\shot.png',
      'C:\\Temp\\attach\\other.png',
    ]);
    expect(input.args).toEqual(['--allowedTools', 'Read', '--add-dir', 'C:/Temp/attach']);
    expect(input.promptPrefix).toContain('C:/Temp/attach/shot.png');
    expect(input.promptPrefix).not.toContain('./C:');
  });

  it('opens the folder of an absolute image to Gemini', () => {
    const input = buildHeadlessImageInput(cli('gemini-cli'), ['/tmp/attach/shot.png']);
    expect(input.args).toEqual(['--include-directories', '/tmp/attach']);
    expect(input.promptPrefix).toBe('@/tmp/attach/shot.png ');
  });

  it('leaves Codex its own flag for an absolute image', () => {
    expect(buildHeadlessImageInput(cli('codex-cli'), ['/tmp/a.png']).args).toEqual([
      '--skip-git-repo-check',
      '--image',
      '/tmp/a.png',
    ]);
  });

  it('lets a run that works in a project keep using its tools', () => {
    const looking = buildHeadlessImageInput(cli('claude-code'), ['a.png']);
    const working = buildHeadlessImageInput(cli('claude-code'), ['a.png'], { lookOnly: false });
    expect(looking.promptPrefix).toContain('Do not read or do anything else');
    expect(working.promptPrefix).not.toContain('Do not read or do anything else');
    expect(working.promptPrefix).toContain('./a.png');
  });

  it('returns nothing without images', () => {
    for (const id of ['claude-code', 'codex-cli', 'gemini-cli']) {
      expect(buildHeadlessImageInput(cli(id), []), id).toEqual({
        args: [],
        promptPrefix: '',
        env: {},
      });
    }
  });

  it('returns nothing for a CLI that cannot take images', () => {
    expect(buildHeadlessImageInput(cli('opencode'), ['frame.png'])).toEqual({
      args: [],
      promptPrefix: '',
      env: {},
    });
  });
});
