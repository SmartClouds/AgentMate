# E42: Dashboard news

Technology news from runovahq.com on the desktop Dashboard, with a clear mark on the items that
affect the tools installed on this machine. Related specs: [E40W Website](40-website.md) (working
rules), [E41 Website API](41-website-api.md), the [API contract](../website/api-contract.md) (the
news resource, technology slugs and the version range grammar) and the
[design spec](../website/design.md) (severity colors and icons).

## Goal

A developer opening Runova sees what changed in their tools this week, and is told plainly when a
security fix applies to something they have installed, with the version to update to.

## The news client (T023)

Lives in the main process, `apps/desktop/src/main/news/`. The renderer never calls the API itself.

- **Endpoint.** `GET https://runovahq.com/api/v1/news` with `pageSize=50` and `sort=-publishedAt`.
  In development builds only (`!app.isPackaged`), `RUNOVA_NEWS_API_URL` replaces the base URL so
  e2e tests and local work can use a fake API on loopback. A packaged build ignores the variable.
- **Network.** Plain `fetch` in the main process, which `installProxyFetch()` in
  `main/network/proxy.ts` already routes through the user's proxy setting. A 15-second timeout, a
  `User-Agent` of `Runova/<version> (<platform>)`, and nothing that identifies the user: no account,
  no machine id, no list of installed tools. Matching happens on this machine only.
- **Caching.** The last good response and its `ETag` are stored in the app's data folder
  (`news-cache.json`). Each poll sends `If-None-Match`; a 304 keeps the cache and only updates
  `checkedAt`. A network error, a timeout or a 5xx serves the cache with `stale: true`. A 4xx is
  logged once and treated like a failure.
- **Polling.** A fetch shortly after start (30 seconds, so start-up stays quick), then every 30
  minutes while the app runs, plus a refresh on demand from the card. No polling at all while news
  is turned off (T025). Polls back off to 2 hours after 3 failures in a row and return to 30 minutes
  after a success.
- **State.** Read and dismissed item ids (with the time) and the ids already notified are stored in
  the app's settings store, so they survive restarts and are part of backup and restore. Ids older
  than 180 days are pruned.
- **Types.** `apps/desktop/src/shared/newsTypes.ts` mirrors `NewsListItemDto` and adds the local
  fields: `read`, `dismissed`, and `affected` (below). The enums are the contract's strings, as
  `as const` arrays so zod and the UI share them.
- **IPC.** A `news` group in `shared/ipcChannels.ts`, every payload checked with zod on the main
  side, with preload methods and the contract tests (`ipcContract.test.ts`,
  `ipcChannels.test.ts`) updated:

| Channel | Direction | Payload | Returns |
|---|---|---|---|
| `news:list` | invoke | `{ category?: Category[], minSeverity?: Severity, page?: number, pageSize?: number }` | `{ items: NewsItemView[], page, totalPages, stale: boolean, checkedAt: string \| null }` |
| `news:get` | invoke | `{ slug: string }` | `NewsItemDetailView \| null` (from `GET /api/v1/news/{slug}`, cached like the list) |
| `news:refresh` | invoke | none | the same as `news:list` with no filters |
| `news:markRead` | invoke | `{ id: number }` | `void` |
| `news:dismiss` | invoke | `{ id: number }` | `void` |
| `news:onChanged` | main to renderer | `{ checkedAt: string, stale: boolean }` | (event) |

Filtering for the card happens over the cached list in the main process, so filters work offline.

## Affects your system

An item is **affected** when at least one of its technologies matches a tool detected on this
machine and the detected version satisfies that technology's `versionRange` under the grammar in
the contract. The matcher is a pure function in `apps/desktop/src/main/news/match.ts` (no Electron
imports) with table tests over the same cases as the API's validation:

```ts
matchNews(item: NewsListItem, installed: InstalledTool[]): AffectedMatch | null
// InstalledTool = { slug: TechnologySlug, version: string, label: string }
// AffectedMatch = { slug, label, version, versionRange, fixedIn }
```

Installed versions come only from what the app already detects; the news feature runs no new
commands:

| Technology slug | Where the version comes from | Label on the badge |
|---|---|---|
| `runova` | `app.getVersion()` | Runova |
| `electron` | `process.versions.electron` | Electron (inside Runova) |
| `nodejs` | Dev Setup item `node`; also `process.versions.node` as a second candidate | Node.js, or Node.js (inside Runova) |
| `git` | Dev Setup item `git` | Git |
| `dotnet` | Dev Setup item `dotnet-sdk` | .NET SDK |
| `docker` | Dev Setup item `docker-desktop` | Docker |
| every `ai-cli` slug | CLI Manager detection, by the ids in `packages/core/src/cli/registry.ts` (the slugs are the same ids) | the CLI's display name |

Rules:

- A tool that is not installed, or whose version could not be read, never matches.
- A version with no numeric part never matches (`unknown`, an empty string).
- When a slug has two candidates (Node.js), each is matched on its own and the badge names the one
  that matched, preferring the installed Node.js.
- An item with `versionRange: "*"` matches any installed version of that tool.
- Only the first match is shown on the badge; the detail sheet lists every affected technology.
- Detection results are read from the existing caches (Dev Setup and CLI Manager) and refreshed
  only when those features refresh; the news client re-matches whenever they change.

### Notifications

A matched item in category `security` at severity `high` or `critical` (or the minimum severity set
in Settings, T025) raises one OS notification and one entry in the notifications list: title
`Security fix for <label>`, body the item's title and `Update to <fixedIn>` when known. Clicking it
opens the Dashboard with the item's detail sheet. Each item notifies at most once, ever: not again
after a restart, after it is read or dismissed, or when a later poll returns it again. An unmatched
item never notifies, and nothing notifies while news is off.

## The dashboard card (T024)

A **News** card registered in `dashboardLayoutStore` like the other cards: on by default for new
installs, added once to an existing saved layout at the end of the first row that has room (no other
card moves), and removable and re-addable from the layout editor.

```text
+ News ------------------------------------ [All categories v] [Any severity v] (refresh) +
| (!) Affects your system: Git 2.47.0                                                    |
| [High] [Security]  Git 2.47.1 fixes a credential leak over HTTP         2h ago   (*)   |
|----------------------------------------------------------------------------------------|
| [Info] [Release]   Node.js 24.11 is the new LTS                         5h ago   (*)   |
| [Info] [AI]        Claude Code adds background tasks                    1d ago         |
|                                                                        View all (24)   |
+----------------------------------------------------------------------------------------+
```

- **Order.** Affected security items first (highest severity first), then everything else newest
  first. Five items on the card; View all opens a dialog with paging (20 a page) and the same
  filters.
- **Row.** Severity badge (icon, label and color from the design spec, never color alone), category
  chip, title, relative time (absolute time in a SimpleTooltip), and an unread dot with an
  accessible name ("Unread"). An affected item shows the badge "Affects your system" naming the
  tool and the installed version.
- **Filters.** Category (multi-select) and minimum severity, kept in the card's settings.
- **States.** Loading shows the app's shimmer on the card only, never on the whole Dashboard. Empty:
  "No news yet." Offline with a cache: the cached items with a small "Offline, showing news from
  <time>" note. Offline with no cache: "News could not be loaded" with Try again. Error from the API:
  the same as offline.
- **Detail sheet.** Opens on click or Enter: title, severity and category, published and updated
  times, the body HTML sanitized again in the renderer with DOMPurify (the API's sanitizing is not
  trusted on its own), affected technologies with version ranges, a "What to do" box for security
  items with the fixed-in version and the matched tool, CVE ids, source links, Open on website (an
  external link to the item's `url`) and Mark as read. Opening the sheet marks the item read.
- **Interaction.** The list is keyboard navigable (arrow keys move, Enter opens, Escape closes the
  sheet), every icon button has a SimpleTooltip instead of a `title` attribute, motion respects
  reduced motion, and the card looks right in all four themes.

## Settings, help and end-to-end (T025)

- **Settings > Notifications, News section.** Show news (on by default; off hides the card and stops
  polling), categories to show (all by default), and "Notify me about security fixes at" with a
  minimum severity (default `high`, or Never). Saved in the settings store, included in backup and
  restore.
- **Command palette.** "Open news" opens the Dashboard and the View all dialog; "Refresh news" calls
  `news:refresh`.
- **Help.** `apps/desktop/src/shared/help/articles/news.md` in the Dashboard category, with the usual
  front matter (`title`, `summary`, `keywords`, `route: /`). It also appears in the website's help
  center, so it follows the site's copy rules (no em dash, no mobile mention).
- **End-to-end.** `apps/desktop/e2e/news.e2e.ts` starts a fake news API on loopback, built like
  `e2e/fakeSentryServer.ts`, and points the app at it with `RUNOVA_NEWS_API_URL`. It checks that
  items show, filters work, the detail sheet opens, Mark as read sticks after a restart, a seeded
  technology version shows the affected badge, and a matched critical item raises exactly one
  notification.

## Privacy

The news request carries no personal data and no information about installed tools; the server only
sees an anonymous GET from an IP address, like any visitor to the website. This is said in the help
article and next to the setting.
