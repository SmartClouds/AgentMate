import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readClaudeAccount } from './claudeAccount';

/**
 * Anthropic renamed the Max tiers: Max 5x is now "Max" and Max 20x is now "Ultra". The account
 * service still reports the old multipliers, so the plan keeps its id and only the label changes.
 */

const FAR_FUTURE = Date.parse('2099-01-01T00:00:00.000Z');

let dir: string;
let previousDir: string | undefined;

async function account(
  credentials: { subscriptionType?: string; rateLimitTier?: string },
  profile: { organizationType?: string; organizationRateLimitTier?: string } = {},
) {
  await writeFile(
    join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'token', expiresAt: FAR_FUTURE, ...credentials },
    }),
  );
  await writeFile(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: profile }));
  return readClaudeAccount();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runova-claude-account-'));
  previousDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
});

afterEach(async () => {
  if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousDir;
  await rm(dir, { recursive: true, force: true });
});

describe('the Claude plan label', () => {
  it('calls the 5x Max tier "Max"', async () => {
    const result = await account({
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
    });

    expect(result.plan).toEqual({ id: 'max5x', label: 'Max' });
  });

  it('calls the 20x Max tier "Ultra"', async () => {
    const result = await account({
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });

    expect(result.plan).toEqual({ id: 'max20x', label: 'Ultra' });
  });

  it('shows Ultra when stale Pro credentials sit next to a 20x profile tier', async () => {
    const result = await account(
      { subscriptionType: 'pro' },
      { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' },
    );

    expect(result.plan).toEqual({ id: 'max20x', label: 'Ultra' });
  });

  it('reads a plan the CLI records as "ultra" as the same Ultra plan', async () => {
    const result = await account({ subscriptionType: 'ultra' });

    expect(result.plan).toEqual({ id: 'max20x', label: 'Ultra' });
  });

  it('leaves Pro as Pro', async () => {
    const result = await account({ subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' });

    expect(result.plan).toEqual({ id: 'pro', label: 'Pro' });
  });
});
