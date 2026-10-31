import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getDevItem } from './catalog.js';
import type { DevSetupEnvironment } from './recipes.js';
import {
  feedUpdateCheck,
  findWingetUpgrade,
  latestStableNuGet,
  parseAptUpgradable,
  parseBrewOutdated,
  parseDnfCheckUpdate,
  parsePacmanQu,
  parseSdkManagerUpdates,
  resolveItemUpdate,
  updateQueryFor,
} from './updates.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf-8');

const win: DevSetupEnvironment = { os: 'win32', arch: 'x64', packageManagers: ['winget'] };
const mac: DevSetupEnvironment = { os: 'darwin', arch: 'arm64', packageManagers: ['brew'] };
const linux = (managers: DevSetupEnvironment['packageManagers']): DevSetupEnvironment => ({
  os: 'linux',
  arch: 'x64',
  packageManagers: managers,
});

const item = (id: string) => {
  const found = getDevItem(id);
  if (!found) throw new Error(`no catalog item ${id}`);
  return found;
};

describe('findWingetUpgrade', () => {
  const real = fixture('winget-upgrade.txt');

  it('reads the installed and the available version from the row with that id', () => {
    expect(findWingetUpgrade(real, 'OpenJS.NodeJS.LTS')).toEqual({
      installed: '24.20.0',
      latest: '24.22.1',
    });
    expect(findWingetUpgrade(real, 'Docker.DockerDesktop')).toEqual({
      installed: '4.96.0',
      latest: '4.96.2',
    });
  });

  it('finds a row whose name has several words and one that fills its whole column', () => {
    expect(findWingetUpgrade(real, 'Microsoft.VisualStudio.Community.Insiders')).toEqual({
      installed: '18.12.12308.306',
      latest: '18.12.12316.0',
    });
    expect(findWingetUpgrade(real, 'Postman.Postman')).toEqual({
      installed: '12.33.1',
      latest: '12.33.3',
    });
  });

  it('matches the id exactly and without regard to case', () => {
    expect(findWingetUpgrade(real, 'openjs.nodejs.lts')).not.toBeNull();
    expect(findWingetUpgrade(real, 'OpenJS.NodeJS')).toBeNull();
    expect(findWingetUpgrade(real, 'GitHub.cli')).toBeNull();
  });

  it('copes with a Source column and with the table of packages that need explicit targeting', () => {
    const withSource = fixture('winget-upgrade-with-source.txt');
    expect(findWingetUpgrade(withSource, 'GitHub.cli')).toEqual({
      installed: '2.102.0',
      latest: '2.103.0',
    });
    expect(findWingetUpgrade(withSource, 'EclipseAdoptium.Temurin.17.JDK')).toEqual({
      installed: '17.0.9.9',
      latest: '17.0.13.11',
    });
  });

  it('ignores a line that names the id but has no versions after it', () => {
    expect(findWingetUpgrade('No installed package found matching GitHub.cli', 'GitHub.cli')).toBe(
      null,
    );
    expect(findWingetUpgrade('', 'GitHub.cli')).toBeNull();
  });
});

describe('parseBrewOutdated', () => {
  const json = JSON.stringify({
    formulae: [
      { name: 'gh', installed_versions: ['2.62.0'], current_version: '2.70.0' },
      { name: 'node', installed_versions: ['22.1.0', '22.2.0'], current_version: '24.0.0' },
    ],
    casks: [{ name: 'docker-desktop', installed_versions: '4.40.0', current_version: '4.41.1' }],
  });

  it('reads formulae and casks, taking the newest installed version', () => {
    const outdated = parseBrewOutdated(json);
    expect(outdated?.get('gh')).toEqual({ installed: '2.62.0', latest: '2.70.0' });
    expect(outdated?.get('node')).toEqual({ installed: '22.2.0', latest: '24.0.0' });
    expect(outdated?.get('docker-desktop')).toEqual({ installed: '4.40.0', latest: '4.41.1' });
  });

  it('says nothing is outdated for an empty answer, and null for text it cannot read', () => {
    expect(parseBrewOutdated('{"formulae":[],"casks":[]}')?.size).toBe(0);
    expect(parseBrewOutdated('Error: nope')).toBeNull();
    expect(parseBrewOutdated('[]')).toBeNull();
  });
});

describe('Linux package manager output', () => {
  it('reads apt list --upgradable', () => {
    const text = [
      'Listing... Done',
      'git/jammy-updates,jammy-security 1:2.34.1-1ubuntu1.12 amd64 [upgradable from: 1:2.34.1-1ubuntu1.10]',
      'nodejs/jammy 22.12.0-1nodesource1 amd64 [upgradable from: 20.1.0-1nodesource1]',
    ].join('\n');
    const upgradable = parseAptUpgradable(text);
    expect(upgradable.get('git')).toEqual({
      installed: '1:2.34.1-1ubuntu1.10',
      latest: '1:2.34.1-1ubuntu1.12',
    });
    expect(upgradable.get('nodejs')?.latest).toBe('22.12.0-1nodesource1');
    expect(upgradable.has('Listing...')).toBe(false);
  });

  it('reads dnf check-update and drops the architecture and the epoch', () => {
    const text = [
      'Last metadata expiration check: 0:12:01 ago.',
      '',
      'git.x86_64                2.43.5-1.fc40            updates',
      'nodejs.x86_64            1:22.12.0-1.fc40          updates',
      'Obsoleting Packages',
      'old.x86_64                1.0-1                    updates',
    ].join('\n');
    const upgradable = parseDnfCheckUpdate(text);
    expect(upgradable.get('git')).toEqual({ installed: null, latest: '2.43.5-1.fc40' });
    expect(upgradable.get('nodejs')?.latest).toBe('22.12.0-1.fc40');
    expect(upgradable.has('old')).toBe(false);
  });

  it('reads pacman -Qu', () => {
    const upgradable = parsePacmanQu(
      'github-cli 2.62.0-1 -> 2.70.0-1\nnodejs 22.1.0-1 -> 22.12.0-1\n',
    );
    expect(upgradable.get('github-cli')).toEqual({ installed: '2.62.0-1', latest: '2.70.0-1' });
    expect(upgradable.size).toBe(2);
  });
});

describe('parseSdkManagerUpdates', () => {
  it('reads the arrows in the installed table of the current sdkmanager', () => {
    const { answered, updates } = parseSdkManagerUpdates(fixture('sdkmanager-list.txt'));

    expect(answered).toBe(true);
    expect(updates.get('emulator')).toEqual({ installed: '36.5.11', latest: '37.2.12' });
    expect(updates.get('platform-tools')).toEqual({ installed: '37.0.0', latest: '37.0.1' });
    // Package ids use `;` everywhere in this app, and the tool writes `/`.
    expect(updates.get('system-images;android-37.0;google_apis_playstore_ps16k;x86_64')).toEqual({
      installed: '4.0.0',
      latest: '8.0.0',
    });
    expect(updates.has('platforms;android-36')).toBe(false);
  });

  it('reads the Available Updates table of an older sdkmanager', () => {
    const text = [
      'Installed packages:',
      '  Path           | Version | Description      | Location',
      '  -------        | ------- | -------          | -------',
      '  platform-tools | 35.0.1  | Platform-Tools   | platform-tools',
      'Available Packages:',
      '  Path                 | Version | Description',
      '  -------              | ------- | -------',
      '  platforms;android-35 | 2       | Android SDK Platform 35',
      'Available Updates:',
      '  ID             | Installed | Available',
      '  -------        | -------   | -------',
      '  platform-tools | 35.0.1    | 35.0.2',
    ].join('\n');
    const { answered, updates } = parseSdkManagerUpdates(text);

    expect(answered).toBe(true);
    expect([...updates.entries()]).toEqual([
      ['platform-tools', { installed: '35.0.1', latest: '35.0.2' }],
    ]);
  });

  it('does not count a failure message as an answer', () => {
    expect(parseSdkManagerUpdates('Error: Could not find or load main class')).toEqual({
      answered: false,
      updates: new Map(),
    });
  });
});

describe('latestStableNuGet', () => {
  it('takes the highest version that is not a preview', () => {
    expect(
      latestStableNuGet({ versions: ['9.0.0', '10.0.13', '10.0.2', '11.0.0-preview.1.1'] }),
    ).toBe('10.0.13');
  });

  it('is null for anything else', () => {
    expect(latestStableNuGet({ versions: [] })).toBeNull();
    expect(latestStableNuGet({ versions: ['1.0.0-rc.1'] })).toBeNull();
    expect(latestStableNuGet(null)).toBeNull();
    expect(latestStableNuGet({ versions: 'nope' })).toBeNull();
  });
});

describe('updateQueryFor', () => {
  it('asks winget about a winget recipe, by id', () => {
    expect(updateQueryFor(item('gh'), win)).toEqual({ source: 'winget', id: 'GitHub.cli' });
    expect(updateQueryFor(item('docker-desktop'), win)).toEqual({
      source: 'winget',
      id: 'Docker.DockerDesktop',
    });
  });

  it('has nothing to ask when winget is missing, since the recipe is then a download page', () => {
    expect(updateQueryFor(item('gh'), { ...win, packageManagers: [] })).toBeNull();
  });

  it('asks Homebrew about a formula and about a cask, even one that needs the terminal', () => {
    expect(updateQueryFor(item('gh'), mac)).toEqual({ source: 'brew', name: 'gh' });
    expect(updateQueryFor(item('dotnet-sdk'), mac)).toEqual({ source: 'brew', name: 'dotnet-sdk' });
  });

  it('asks the Linux manager the recipe would run, with its package names', () => {
    expect(updateQueryFor(item('node'), linux(['apt-get', 'dnf']))).toEqual({
      source: 'apt-get',
      packages: ['nodejs', 'npm'],
    });
    expect(updateQueryFor(item('gh'), linux(['pacman']))).toEqual({
      source: 'pacman',
      packages: ['github-cli'],
    });
    expect(updateQueryFor(item('gh'), linux([]))).toBeNull();
  });

  it('uses the registry or the feed that belongs to the recipe', () => {
    expect(updateQueryFor(item('pnpm'), win)).toEqual({ source: 'npm', package: 'pnpm' });
    expect(updateQueryFor(item('dotnet-ef'), win)).toEqual({
      source: 'nuget',
      package: 'dotnet-ef',
    });
    expect(updateQueryFor(item('flutter'), win)).toEqual({ source: 'flutter' });
  });

  it('asks winget about Bun on Windows and the npm registry elsewhere', () => {
    expect(updateQueryFor(item('bun'), win)).toEqual({ source: 'winget', id: 'Oven-sh.Bun' });
    expect(updateQueryFor(item('bun'), mac)).toEqual({ source: 'npm', package: 'bun' });
    expect(updateQueryFor(item('bun'), linux(['apt-get']))).toEqual({
      source: 'npm',
      package: 'bun',
    });
  });

  it('names the sdkmanager package for the CPU, and skips what cannot be updated that way', () => {
    expect(updateQueryFor(item('android-platform-tools'), win)).toEqual({
      source: 'sdkmanager',
      package: 'platform-tools',
    });
    expect(updateQueryFor(item('android-system-image'), mac)).toEqual({
      source: 'sdkmanager',
      package: 'system-images;android-36;google_apis;arm64-v8a',
    });
    expect(updateQueryFor(item('android-cmdline-tools'), win)).toBeNull();
    expect(updateQueryFor(item('android-licenses'), win)).toBeNull();
  });

  it('has nothing to ask for rows that come with another tool or are only a step', () => {
    for (const id of ['npm', 'dart', 'gh-auth', 'docker-running', 'wsl2']) {
      expect(updateQueryFor(item(id), win)).toBeNull();
    }
    expect(updateQueryFor(item('git'), mac)).toBeNull();
    expect(updateQueryFor(item('xcode'), mac)).toBeNull();
  });
});

describe('resolveItemUpdate', () => {
  it('names the newer version when it is on the same scale as the installed one', () => {
    expect(
      resolveItemUpdate('2.102.0', { state: 'update', latest: '2.103.0', installed: '2.102.0' }),
    ).toEqual({ latest: '2.103.0' });
    expect(
      resolveItemUpdate('24.20.0', { state: 'update', latest: '24.22.1', installed: '24.20.0' }),
    ).toEqual({ latest: '24.22.1' });
  });

  it('cuts the version to three parts, and to a generic update when that is not newer', () => {
    expect(
      resolveItemUpdate('17.0.9', { state: 'update', latest: '17.0.13.11', installed: '17.0.9.9' }),
    ).toEqual({ latest: '17.0.13' });
    expect(
      resolveItemUpdate('2.55.0', { state: 'update', latest: '2.55.0.2', installed: '2.55.0.1' }),
    ).toEqual({ latest: null });
  });

  it('does not put two numbers side by side when they are not on one scale', () => {
    // Docker Desktop is 4.96 to winget, and the engine it was probed with is 28.x.
    expect(
      resolveItemUpdate('28.5.1', { state: 'update', latest: '4.96.2', installed: '4.96.0' }),
    ).toEqual({ latest: null });
  });

  it('is null when there is no update or the check could not be made', () => {
    expect(resolveItemUpdate('1.0.0', { state: 'current' })).toBeNull();
    expect(resolveItemUpdate('1.0.0', { state: 'unknown' })).toBeNull();
    expect(resolveItemUpdate('1.0.0', undefined)).toBeNull();
  });

  it('keeps an update whose version nobody could read', () => {
    expect(
      resolveItemUpdate(null, { state: 'update', latest: '2.0.0', installed: '1.0.0' }),
    ).toEqual({
      latest: null,
    });
    expect(resolveItemUpdate('3.1.0', { state: 'update', latest: null, installed: null })).toEqual({
      latest: null,
    });
  });
});

describe('feedUpdateCheck', () => {
  it('is an update only when the feed is ahead of what is installed', () => {
    expect(feedUpdateCheck('10.0.9', '10.0.13')).toEqual({
      state: 'update',
      latest: '10.0.13',
      installed: null,
    });
    expect(feedUpdateCheck('10.0.13', '10.0.13')).toEqual({ state: 'current' });
    expect(feedUpdateCheck('11.0.0', '10.0.13')).toEqual({ state: 'current' });
  });

  it('cannot say when either side is missing', () => {
    expect(feedUpdateCheck(null, '1.0.0')).toEqual({ state: 'unknown' });
    expect(feedUpdateCheck('1.0.0', null)).toEqual({ state: 'unknown' });
  });
});
