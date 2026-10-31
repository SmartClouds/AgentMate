import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRuntimeFeedCache,
  fetchLatestFromRegistry,
  parseDartVersion,
  parseDotnetIndex,
  parseNodeIndex,
  runtimeFeeds,
} from './runtimeFeeds';

/** Trimmed copies of the real feeds, keeping the fields the parsers read. */
const NODE_INDEX = [
  { version: 'v25.1.0', lts: false },
  { version: 'v24.11.1', lts: 'Krypton' },
  { version: 'v22.21.1', lts: 'Jod' },
];

const DOTNET_INDEX = {
  'releases-index': [
    {
      'channel-version': '11.0',
      'latest-sdk': '11.0.100-preview.1.26101.1',
      'support-phase': 'preview',
    },
    { 'channel-version': '10.0', 'latest-sdk': '10.0.100', 'support-phase': 'active' },
    { 'channel-version': '9.0', 'latest-sdk': '9.0.306', 'support-phase': 'active' },
    { 'channel-version': '8.0', 'latest-sdk': '8.0.415', 'support-phase': 'active' },
    { 'channel-version': '7.0', 'latest-sdk': '7.0.410', 'support-phase': 'eol' },
  ],
};

describe('parsers', () => {
  it('picks the newest LTS line of Node.js, not the newest release', () => {
    expect(parseNodeIndex(NODE_INDEX)).toBe('24.11.1');
    expect(parseNodeIndex([{ version: 'v25.0.0', lts: false }])).toBeNull();
    expect(parseNodeIndex({})).toBeNull();
  });

  it('picks the newest .NET channel that is generally available', () => {
    expect(parseDotnetIndex(DOTNET_INDEX)).toEqual({ channel: '10.0', latestSdk: '10.0.100' });
  });

  it('does not depend on the order of the .NET index', () => {
    const shuffled = { 'releases-index': [...DOTNET_INDEX['releases-index']].reverse() };
    expect(parseDotnetIndex(shuffled)).toEqual({ channel: '10.0', latestSdk: '10.0.100' });
  });

  it('returns null for a .NET index with no usable channel', () => {
    expect(parseDotnetIndex({ 'releases-index': [{ 'support-phase': 'preview' }] })).toBeNull();
    expect(parseDotnetIndex(null)).toBeNull();
  });

  it('reads the Dart stable VERSION file', () => {
    expect(parseDartVersion({ version: '3.13.5', revision: 'abc' })).toBe('3.13.5');
    expect(parseDartVersion({ version: '3.14.0-1.0.dev' })).toBeNull();
    expect(parseDartVersion('3.13.5')).toBeNull();
  });
});

describe('fetching', () => {
  let requested: string[];

  function stubFetch(routes: Record<string, unknown>): void {
    requested = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      requested.push(String(url));
      const body = Object.entries(routes).find(([part]) => String(url).includes(part))?.[1];
      if (body === undefined) return new Response('Not found', { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    });
  }

  beforeEach(() => {
    clearRuntimeFeedCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('asks each feed where it lives', async () => {
    stubFetch({
      'nodejs.org/dist/index.json': NODE_INDEX,
      'release-metadata/releases-index.json': DOTNET_INDEX,
      'dart-archive/channels/stable/release/latest/VERSION': { version: '3.13.5' },
      'registry.npmjs.org/bun/latest': { version: '1.3.2' },
    });

    expect(await runtimeFeeds.nodeLts()).toBe('24.11.1');
    expect(await runtimeFeeds.dotnet()).toEqual({ channel: '10.0', latestSdk: '10.0.100' });
    expect(await runtimeFeeds.dart()).toBe('3.13.5');
    expect(await runtimeFeeds.npmPackage('bun')).toBe('1.3.2');
  });

  it('asks a feed once while its answer is fresh, even for concurrent callers', async () => {
    stubFetch({ 'nodejs.org/dist/index.json': NODE_INDEX });

    await Promise.all([runtimeFeeds.nodeLts(), runtimeFeeds.nodeLts()]);
    await runtimeFeeds.nodeLts();

    expect(requested).toHaveLength(1);
  });

  it('answers null when a feed fails, and asks again a minute later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    stubFetch({});

    expect(await runtimeFeeds.dart()).toBeNull();
    expect(await runtimeFeeds.dart()).toBeNull();
    expect(requested).toHaveLength(1);

    vi.setSystemTime(Date.now() + 61_000);
    stubFetch({ 'dart-archive': { version: '3.13.5' } });
    expect(await runtimeFeeds.dart()).toBe('3.13.5');
  });

  it('keeps a good answer for half an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    stubFetch({ 'dart-archive': { version: '3.13.5' } });
    await runtimeFeeds.dart();

    vi.setSystemTime(Date.now() + 29 * 60_000);
    await runtimeFeeds.dart();
    expect(requested).toHaveLength(1);

    vi.setSystemTime(Date.now() + 2 * 60_000);
    await runtimeFeeds.dart();
    expect(requested).toHaveLength(2);
  });

  it('reads the Flutter stable release and the Dart inside it', async () => {
    const manifest = {
      base_url: 'https://storage.googleapis.com/flutter_infra_release/releases',
      current_release: { stable: 'h1' },
      releases: [
        {
          hash: 'h1',
          channel: 'stable',
          version: '3.47.7',
          dart_sdk_version: '3.13.5',
          dart_sdk_arch:
            process.platform === 'darwin' && process.arch === 'arm64' ? 'arm64' : 'x64',
          archive: `stable/${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'}/flutter_3.47.7-stable.zip`,
          sha256: 'a'.repeat(64),
        },
      ],
    };
    stubFetch({ flutter_infra_release: manifest });

    expect(await runtimeFeeds.flutter()).toEqual({ version: '3.47.7', dartVersion: '3.13.5' });
  });

  it('looks up an npm package and answers null when the registry is unreachable', async () => {
    stubFetch({ 'registry.npmjs.org/pnpm/latest': { version: '10.20.0' } });
    expect(await fetchLatestFromRegistry('pnpm')).toBe('10.20.0');
    expect(await fetchLatestFromRegistry('no-such-package')).toBeNull();

    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    expect(await fetchLatestFromRegistry('pnpm')).toBeNull();
  });
});
