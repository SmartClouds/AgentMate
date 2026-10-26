import {
  appliesToOs,
  type DevDetection,
  type DevItemId,
  type DevSetupEnvironment,
  type DevUpdateCheck,
  type DevUpdateQuery,
  feedUpdateCheck,
  findWingetUpgrade,
  flutterManifestUrl,
  getDevItem,
  latestStableNuGet,
  parseAptUpgradable,
  parseBrewOutdated,
  parseDnfCheckUpdate,
  parsePacmanQu,
  parseSdkManagerUpdates,
  pickFlutterRelease,
  type UpdateOffer,
  updateQueryFor,
} from '@runova/core';
import type { ProbeResult } from './probe';

/**
 * Finds out which installed tools have a newer version. Each source is asked one question for
 * everything it covers (winget for the whole list, not once per tool), the answer is remembered
 * for half an hour, and a source that cannot be reached leaves its own tools "unknown" without
 * touching anyone else's. The machine (commands, network, clock) is injected.
 */

export interface UpdateCheckerDeps {
  environment: () => Promise<DevSetupEnvironment>;
  detect: (id: DevItemId) => Promise<DevDetection>;
  probe: (
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ) => Promise<ProbeResult>;
  /** The newest version an npm package has, or null when the registry cannot be reached. */
  latestNpm: (pkg: string) => Promise<string | null>;
  /** Throws when the request fails. */
  fetchJson: (url: string) => Promise<unknown>;
  /** What `sdkmanager --list` printed, or null when there is no sdkmanager to run. */
  sdkmanagerList: () => Promise<string | null>;
  now: () => number;
}

export interface DevUpdateChecker {
  /**
   * What each of these items has on offer. An item that has no way to be asked, or whose source did
   * not answer, comes back `unknown`. `force` skips what is remembered; forcing a single item asks
   * about just that one, which is how a row is looked at again after an update.
   */
  check(
    ids: readonly DevItemId[],
    options?: { force?: boolean },
  ): Promise<Record<DevItemId, DevUpdateCheck>>;
  /** Drops what is remembered for these items. */
  forget(ids: readonly DevItemId[]): void;
}

/** Long enough that opening the page again is instant, short enough that a release is soon seen. */
const FRESH_MS = 30 * 60_000;
/** A source that failed is tried again sooner: it is often a connection that was not up yet. */
const RETRY_MS = 60_000;
const WINGET_TIMEOUT_MS = 90_000;
const BREW_TIMEOUT_MS = 90_000;
const LINUX_TIMEOUT_MS = 60_000;

const UNKNOWN: DevUpdateCheck = { state: 'unknown' };
const CURRENT: DevUpdateCheck = { state: 'current' };

interface Entry<S extends DevUpdateQuery['source'] = DevUpdateQuery['source']> {
  id: DevItemId;
  query: Extract<DevUpdateQuery, { source: S }>;
}

type Answers = Map<DevItemId, DevUpdateCheck>;

function offerCheck(offer: UpdateOffer | null | undefined): DevUpdateCheck {
  return offer ? { state: 'update', latest: offer.latest, installed: offer.installed } : CURRENT;
}

function allUnknown(entries: readonly { id: DevItemId }[]): Answers {
  return new Map(entries.map((entry) => [entry.id, UNKNOWN]));
}

/** The command did not run to an answer: missing, killed for taking too long, or it never started. */
function noAnswer(result: ProbeResult): boolean {
  return result.notFound || result.timedOut || result.error !== null;
}

export function createUpdateChecker(deps: UpdateCheckerDeps): DevUpdateChecker {
  const cache = new Map<DevItemId, { at: number; check: DevUpdateCheck }>();
  const inFlight = new Map<string, Promise<Answers>>();

  async function askWinget(entries: Entry<'winget'>[], force: boolean): Promise<Answers> {
    const only = force && entries.length === 1 ? entries[0] : undefined;
    const result = await deps.probe(
      'winget',
      [
        'upgrade',
        // One tool is asked by name, so a recheck after an update does not list every package.
        ...(only ? ['--id', only.query.id, '--exact'] : []),
        '--source',
        'winget',
        '--accept-source-agreements',
        '--disable-interactivity',
      ],
      { timeoutMs: WINGET_TIMEOUT_MS },
    );
    if (noAnswer(result) || !result.output.trim()) return allUnknown(entries);
    // Which id has a row is all that matters: no row means winget has nothing newer for it.
    return new Map(
      entries.map((entry) => [
        entry.id,
        offerCheck(findWingetUpgrade(result.output, entry.query.id)),
      ]),
    );
  }

  async function askBrew(entries: Entry<'brew'>[]): Promise<Answers> {
    const result = await deps.probe('brew', ['outdated', '--json=v2', '--greedy'], {
      timeoutMs: BREW_TIMEOUT_MS,
    });
    const outdated = noAnswer(result) ? null : parseBrewOutdated(result.stdout);
    if (!outdated) return allUnknown(entries);
    return new Map(entries.map((entry) => [entry.id, offerCheck(outdated.get(entry.query.name))]));
  }

  async function askLinux(
    source: 'apt-get' | 'dnf' | 'pacman',
    entries: Entry<'apt-get' | 'dnf' | 'pacman'>[],
  ): Promise<Answers> {
    const command =
      source === 'apt-get'
        ? ['apt', ['list', '--upgradable']]
        : source === 'dnf'
          ? ['dnf', ['check-update', '-q']]
          : ['pacman', ['-Qu']];
    const result = await deps.probe(command[0] as string, command[1] as string[], {
      timeoutMs: LINUX_TIMEOUT_MS,
    });
    // dnf exits 100 when there are updates and pacman exits 1 when there are none. Anything else
    // is a failure, and a failure must not read as "up to date".
    const answered =
      !noAnswer(result) &&
      (source === 'apt-get'
        ? result.code === 0
        : source === 'dnf'
          ? result.code === 0 || result.code === 100
          : result.code === 0 || result.code === 1);
    if (!answered) return allUnknown(entries);

    const upgradable =
      source === 'apt-get'
        ? parseAptUpgradable(result.output)
        : source === 'dnf'
          ? parseDnfCheckUpdate(result.stdout)
          : parsePacmanQu(result.stdout);
    return new Map(
      entries.map((entry) => {
        const name = entry.query.packages.find((one) => upgradable.has(one));
        return [entry.id, offerCheck(name ? upgradable.get(name) : undefined)];
      }),
    );
  }

  /** A source that only names the newest version: compared with what the tool itself reports. */
  async function askFeed(
    entries: Entry[],
    latestOf: (entry: Entry) => Promise<string | null>,
  ): Promise<Answers> {
    const answers: Answers = new Map();
    await Promise.all(
      entries.map(async (entry) => {
        try {
          const detection = await deps.detect(entry.id);
          if (detection.state !== 'found') {
            answers.set(entry.id, UNKNOWN);
            return;
          }
          answers.set(entry.id, feedUpdateCheck(detection.version, await latestOf(entry)));
        } catch {
          answers.set(entry.id, UNKNOWN);
        }
      }),
    );
    return answers;
  }

  async function askSdkManager(entries: Entry<'sdkmanager'>[]): Promise<Answers> {
    const text = await deps.sdkmanagerList();
    const { answered, updates } = text
      ? parseSdkManagerUpdates(text)
      : { answered: false, updates: new Map<string, UpdateOffer>() };
    if (!answered) return allUnknown(entries);
    return new Map(
      entries.map((entry) => [entry.id, offerCheck(updates.get(entry.query.package))]),
    );
  }

  async function ask(
    source: DevUpdateQuery['source'],
    entries: Entry[],
    environment: DevSetupEnvironment,
    force: boolean,
  ): Promise<Answers> {
    try {
      switch (source) {
        case 'winget':
          return await askWinget(entries as Entry<'winget'>[], force);
        case 'brew':
          return await askBrew(entries as Entry<'brew'>[]);
        case 'apt-get':
        case 'dnf':
        case 'pacman':
          return await askLinux(source, entries as Entry<'apt-get' | 'dnf' | 'pacman'>[]);
        case 'npm':
          return await askFeed(entries, (entry) =>
            deps.latestNpm((entry.query as Extract<DevUpdateQuery, { source: 'npm' }>).package),
          );
        case 'nuget':
          return await askFeed(entries, async (entry) => {
            const name = (entry.query as Extract<DevUpdateQuery, { source: 'nuget' }>).package;
            const url = `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(name.toLowerCase())}/index.json`;
            return latestStableNuGet(await deps.fetchJson(url));
          });
        case 'flutter':
          return await askFeed(entries, async () => {
            const manifest = await deps.fetchJson(flutterManifestUrl(environment.os));
            return pickFlutterRelease(manifest, environment.os, environment.arch)?.version ?? null;
          });
        case 'sdkmanager':
          return await askSdkManager(entries as Entry<'sdkmanager'>[]);
      }
    } catch {
      // A source that threw says nothing about its tools, and must not take the page down.
      return allUnknown(entries);
    }
  }

  return {
    async check(ids, options = {}) {
      const force = options.force === true;
      const environment = await deps.environment();
      const result: Record<DevItemId, DevUpdateCheck> = {};
      const toAsk = new Map<DevUpdateQuery['source'], Entry[]>();

      for (const id of new Set(ids)) {
        const item = getDevItem(id);
        const query =
          item && appliesToOs(item, environment.os) ? updateQueryFor(item, environment) : null;
        if (!query) {
          result[id] = UNKNOWN;
          continue;
        }
        const hit = cache.get(id);
        const lifetime = hit?.check.state === 'unknown' ? RETRY_MS : FRESH_MS;
        if (!force && hit && deps.now() - hit.at < lifetime) {
          result[id] = hit.check;
          continue;
        }
        toAsk.set(query.source, [...(toAsk.get(query.source) ?? []), { id, query }]);
      }

      await Promise.all(
        [...toAsk].map(async ([source, entries]) => {
          // Two checks that arrive together share one question.
          const key = `${source}|${force && entries.length === 1 ? 'one' : 'all'}|${entries
            .map((entry) => entry.id)
            .sort()
            .join(',')}`;
          let pending = inFlight.get(key);
          if (!pending) {
            pending = ask(source, entries, environment, force).finally(() => {
              inFlight.delete(key);
            });
            inFlight.set(key, pending);
          }
          const answers = await pending;
          for (const { id } of entries) {
            const check = answers.get(id) ?? UNKNOWN;
            result[id] = check;
            cache.set(id, { at: deps.now(), check });
          }
        }),
      );
      return result;
    },

    forget(ids) {
      for (const id of ids) cache.delete(id);
    },
  };
}
