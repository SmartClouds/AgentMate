# E40W: Website

The epic id is **E40W** because E40 is already taken by [reCAPTCHA keys](40-recaptcha-keys.md); its
row in `docs/DELIVERY_STATUS.md` is `E40W`. Related specs: [E41 Website API](41-website-api.md),
[E42 Dashboard news](42-dashboard-news.md), the [API contract](../website/api-contract.md) and the
[design spec](../website/design.md).

## Goal

A public website at `https://runovahq.com` that explains what Runova is, shows the real app, gets
visitors to the right installer, carries the help center, a blog and technology news, and gives
staff a small admin area to write the blog and the news. The news also feeds the desktop
Dashboard (E42).

## Where the work happens

Every task after T001 works in the git worktree `../Runova-website` on branch `website`, made from
the commit that added these specs. T028 merges `website` into `master` locally and removes the
worktree. Nothing is pushed by these tasks.

## Architecture

```text
                         https://runovahq.com (one origin)
                                     |
                              reverse proxy (TLS)
              /api/*, /media/*, /hangfire*   |   everything else
                         |                   |
          apps/website/api (.NET 10)     apps/website/web (Astro on bun)
                         |                   |  server-side calls to the API
                    PostgreSQL 18  <---------+  over the internal network
```

- **apps/website/web**: Astro (latest stable), with bun as package manager and runtime and
  `bun.lock` committed. `@astrojs/node` in standalone mode, run with `bun ./dist/server/entry.mjs`,
  serves the on-demand routes; static routes are prerendered at build. React islands for anything
  interactive, MDX for the features content, Tailwind CSS 4 and shadcn/ui for styling. The site is
  outside the pnpm workspace (`pnpm-workspace.yaml` matches `apps/*`, and the site is two levels
  down) and has its own `biome.json`; Biome at the root ignores `apps/website/**`. Root scripts in
  `package.json` call `scripts/website.mjs` (`website:dev`, `website:build`, `website:test`,
  `website:e2e`), which runs bun in that folder.
- **apps/website/api**: ASP.NET Core on .NET 10 with EF Core on PostgreSQL. Its own solution,
  layout and conventions are in [E41](41-website-api.md). Root scripts call
  `scripts/website-api.mjs`.
- **One origin.** The reverse proxy sends `/api/`, `/media/` and `/hangfire` to the API and the
  rest to the web server, so cookies are first-party, no CORS is configured, and the admin pages
  call `/api/v1` with relative URLs. In development, Astro's dev server proxies `/api` and `/media`
  to the API (`WEBSITE_API_URL`, default `http://localhost:5180`). Server-side rendering reads the
  API at `WEBSITE_API_INTERNAL_URL` (inside compose, `http://api:8080`) and never through the public
  URL. The proxy in `apps/website/compose.yaml` is Caddy (T026).
- **Environment.** Web: `SITE_URL`, `WEBSITE_API_INTERNAL_URL`, `PUBLIC_SENTRY_DSN`,
  `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`. An empty value turns the feature off and breaks nothing.

## Routes

Static routes are built once per deploy. On-demand routes are rendered per request by the Node
adapter and cached by the `Cache-Control` they send (the proxy and browsers honor it).

| Route | Rendering | Cache-Control | Task |
|---|---|---|---|
| `/` | static | `public, max-age=600` | T014 |
| `/features`, `/features/<slug>` | static | `public, max-age=600` | T015 |
| `/help`, `/help/<slug>` | static (Pagefind index built with it) | `public, max-age=600` | T016 |
| `/download` | on demand | `public, max-age=300, stale-while-revalidate=600` | T017 |
| `/blog`, `/blog/page/<n>` | on demand | `public, max-age=60, stale-while-revalidate=300` | T018 |
| `/blog/<slug>` | on demand | `public, max-age=300, stale-while-revalidate=600` | T018 |
| `/blog/tags/<tag>` | on demand | `public, max-age=60, stale-while-revalidate=300` | T018 |
| `/blog/rss.xml` | on demand | `public, max-age=600, stale-while-revalidate=600` | T018 |
| `/news` (filters in the query string) | on demand | `public, max-age=60, stale-while-revalidate=300` | T019 |
| `/news/<slug>` | on demand | `public, max-age=300, stale-while-revalidate=600` | T019 |
| `/news/rss.xml` | on demand | `public, max-age=300, stale-while-revalidate=600` | T019 |
| `/news-sitemap.xml` | on demand | `public, max-age=300` | T019 |
| `/admin`, `/admin/**` | on demand | `private, no-store` | T020, T021 |
| `/privacy`, `/terms` | static | `public, max-age=600` | T022 |
| `/sitemap-index.xml`, `/sitemap-*.xml` | static part from `@astrojs/sitemap`, plus an on-demand `/sitemap-dynamic.xml` for blog and news | `public, max-age=600` | T022 |
| `/robots.txt`, `/llms.txt` | static | `public, max-age=3600` | T022 |
| `/404`, `/500` | static | `no-store` with the real status code | T022 |

- An on-demand page whose API call fails renders a useful page, not a stack trace: the download page
  falls back to the version known at build time and a GitHub Releases link, and blog and news show a
  short "could not load" state with status 503 and `Retry-After`.
- Unknown blog or news slugs answer HTTP 404 with the site's 404 page, never a 200.
- Static asset files under `/_astro/` are fingerprinted and sent with
  `public, max-age=31536000, immutable`.

## SEO rules

- **URLs.** Lowercase, hyphenated, no trailing slash (`trailingSlash: 'never'`); a trailing slash
  redirects with 301 to the URL without it. The canonical is always `SITE_URL` plus the path, with no
  query string except `page` on paged lists. Filtered `/news` URLs carry a canonical to `/news`.
- **Head.** Every page has a unique `<title>` (template `%s | Runova`, the home page is just
  `Runova: the Agentic Development Environment`), a unique meta description of 70 to 160
  characters, the canonical link, Open Graph (`og:title`, `og:description`, `og:url`, `og:type`,
  `og:image` 1200x630, `og:site_name`) and Twitter card (`summary_large_image`). T022 fails the
  build when two pages share a title or description.
- **Structured data.** JSON-LD typed with `schema-dts`: `Organization` and `WebSite` on every page,
  `SoftwareApplication` on home and download, `BreadcrumbList` on features and help,
  `TechArticle` on help articles, `BlogPosting` on posts, `NewsArticle` on news items.
- **Indexing.** `/admin/**` sends `noindex, nofollow` (meta and `X-Robots-Tag`), is left out of every
  sitemap and is disallowed in `robots.txt` together with `/api/`. Paged lists past page 1 are
  indexable with their own canonical.
- **Feeds and sitemaps.** RSS 2.0 for the blog and the news, a Google News sitemap with items from
  the last two days, a sitemap index over the static and dynamic sitemaps, and `llms.txt` with a
  short description and the main links.
- **Performance budgets.** Lighthouse on mobile emulation: performance 90 or more, accessibility 95
  or more, best practices 95 or more, SEO 100; LCP under 2.5 s and CLS under 0.1. Images go through
  `astro:assets` (AVIF and WebP, width and height always set, lazy below the fold).
- **Security headers** from the adapter middleware: a CSP with nonces for inline scripts (no
  `unsafe-inline` for scripts), HSTS (`max-age=63072000; includeSubDomains; preload`),
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`,
  `Permissions-Policy` denying camera, microphone and geolocation, and `frame-ancestors 'none'`.
- **Language.** English only, `lang="en"`, copy written fresh from the README and the help articles.

## Screenshots

Real screenshots of the app made from demo data (the made-up Northwind shop from the README) by
`apps/desktop/e2e/websiteShots.e2e.ts`, which runs only with `RUNOVA_WEBSITE_SHOTS=1`. Every shot is
1600x1000 at 2x scale, in Dark unless the name says otherwise, and lands in
`apps/website/web/src/assets/screenshots/<name>.png` with an entry in `manifest.json`
(`{ "name", "route", "theme", "alt" }`, where `route` is the in-app route the spec opened). No shot
may show a home folder path, an OS user name, a token, or anything on the forbidden list below.

Captured by **T012**:

| Name | Screen |
|---|---|
| `dashboard` | Dashboard with the default cards |
| `workspace` | Workspace with an agent pane, a diff tab and the git panel open |
| `workspace-light` | The same workspace in Light |
| `workspace-vscode-dark` | The same workspace in VS Code Dark |
| `workspace-vs2026` | The same workspace in VS 2026 |
| `workspace-git` | Source control with changes staged by hunk |
| `projects` | The Projects list |
| `project-detail` | A project's detail page |
| `blueprint` | A project's Blueprint, partway through |
| `prompt-builder` | Prompt Builder with a generated prompt |
| `cli-manager` | AI CLI Manager with several CLIs installed |
| `skills` | Skills with installed skills |
| `skill-security` | Skills, Security, with a finished check |
| `mcp` | MCP Servers |
| `agent-tools` | Agent Tools with the Dev Setup checklist |
| `vault` | Vault with demo entries |
| `settings` | Settings, General tab |

Captured by **T013** (with the DevHost, fake servers and seeded files):

| Name | Screen |
|---|---|
| `deploy-overview` | Deploy, a server's Overview |
| `deploy-containers` | Deploy, Containers |
| `deploy-app-store` | Deploy, App Store |
| `deploy-websites` | Deploy, Websites |
| `deploy-firewall` | Deploy, Firewall |
| `deploy-backups` | Deploy, Backups |
| `monitoring-uptime` | Monitoring, Uptime |
| `monitoring-errors` | Monitoring, Errors (from the fake Sentry server) |
| `relay` | The Relay board with seeded task files |
| `usage` | Token Usage from seeded local logs |
| `pipelines` | Pipelines against a fake GitHub |
| `docker` | The Docker page |
| `api-client` | API Client with a request and its response |
| `ssh` | Remote, SSH tab with saved servers |
| `remote-desktop` | Remote, Remote Desktop tab with saved servers |
| `studio` | Studio with a video open |
| `help` | The Help center |
| `ai-pet` | The AI Pet card in Settings |

On the Remote page only the SSH and Remote Desktop tabs are captured.

## Features

`src/content/features/` holds one MDX entry per group below (T015). The test in T015 checks that
every README feature name in this table maps to exactly one entry, and that every entry exists.
Studio has no README bullet; its copy comes from `studio.md` in the help articles.

| Entry slug | Title | README features it covers | Screenshots |
|---|---|---|---|
| `workspace` | Workspace and agent status | Multi-pane workspace; Agent status; Prompt hand-off; Launcher menu; Browser tab; Worktrees; Running CLIs; Keep awake | `workspace`, `workspace-light`, `workspace-vscode-dark`, `workspace-vs2026` |
| `git-and-review` | Git, diffs and review | Git, diffs and the editor, right next to the agents; Review; Git and releases | `workspace-git` |
| `tests` | Tests | Tests | `workspace` |
| `relay` | Relay | Relay | `relay` |
| `token-usage` | Token usage and auto-continue | Token usage and auto-continue | `usage` |
| `projects` | Projects | Project workspace; Run commands; WordPress projects; Security; Packages; Environments; Setup | `projects`, `project-detail` |
| `build` | Build | Blueprint; Prompt Builder; Prompt History; Scheduled prompts; Writing check; Ask AI; API Client | `blueprint`, `prompt-builder`, `api-client` |
| `agents` | Agents | AI CLI Manager; CLI arguments and launch defaults; Skill Marketplace; Skill Security; MCP Marketplace; Agent Tools | `cli-manager`, `skills`, `skill-security`, `mcp`, `agent-tools` |
| `ship` | Ship | Pipelines; Deploy; Monitoring; Docker; Android | `pipelines`, `deploy-overview`, `deploy-containers`, `deploy-app-store`, `deploy-websites`, `deploy-firewall`, `deploy-backups`, `monitoring-uptime`, `monitoring-errors`, `docker` |
| `connect` | Connect | Remote; SSH; RDP; Vault | `ssh`, `remote-desktop`, `vault` |
| `studio` | Studio | (none, from the Studio help article) | `studio` |
| `more` | Everything else | Dashboard; Status bar; Notifications; Help center; AI Pet; Settings; Proxy; Also in the app | `dashboard`, `help`, `ai-pet`, `settings` |

The Remote copy describes controlling another Runova computer over the local network and the
remote file manager, and nothing else from that README bullet. The Android copy describes emulators,
virtual devices and connected devices for testing the visitor's own apps.

## Help articles on the site

T016 loads `apps/desktop/src/shared/help/articles/*.md` at build time (the files are never changed
for the site), with the categories from the `category` front matter exactly as
`apps/desktop/src/shared/help/parse.ts` reads them (missing means `Getting started`). Each article
becomes `/help/<file name without .md>`. Links between articles (a link to `vault.md`) become `/help/vault`;
in-app routes in front matter (`route: /deploy`) link to the matching features entry. Before
rendering, the loader drops the content listed under "Help filter" in the forbidden block below, and
a test fails when a built help page still contains a forbidden phrase. The Android article, the
Deploy App Store article and the Android emulator example in `projects.md` stay as they are.

## Forbidden phrases

Runova's mobile version is not mentioned anywhere on the site: not in copy, alt text, help pages,
metadata, JSON-LD, feeds or screenshots. The block below is what the tests read: the phrases are
its lines up to the first line that starts with `#` (one phrase per line, matched
case-insensitively against visible text and attributes), and the help filter rules follow that
line. The Deploy "App Store" and the Android features (emulators, virtual devices, connected
devices, `adb`) are allowed and must not be filtered.

```forbidden
Runova mobile
Runova for iPhone
Runova for Android
Runova app for iPhone
mobile version of Runova
mobile companion
companion app
companion mobile app
the mobile app control
from the mobile app
or the mobile app
scan the QR with the Runova mobile app
pair the Runova mobile app
pair your phone
pair it again
iPhone
iPad
iOS app
TestFlight
Google Play
Play Store
React Native

# Help filter (T016), applied to the article source before rendering
remote.md: front matter summary -> "Control another Runova over your network, connect to servers over SSH, and open Windows Remote Desktop sessions."
remote.md: front matter keywords -> drop "mobile", "phone", "companion app"
remote.md: line "**Host** (let another Runova or the mobile app control this computer)" -> "**Host** (let another Runova control this computer)"
remote.md: sentence "...on the same network, and from the Runova mobile app." -> "...on the same network."
remote.md: step "scan the QR with the Runova mobile app, or copy the text" -> "copy the text"
remote.md: drop the whole "## The Runova mobile app" section with its "###" children, up to the next "## " heading
README (if quoted anywhere): drop the "Phones." bullet under Why "Runova", and "including from the companion mobile app" in Connect > Remote
```

The filter is written as data the loader applies (match a heading or an exact phrase, then drop or
replace), so a new article with a mobile mention fails the scan instead of slipping through.

## Working rules

Every task in this epic and in E41 and E42 follows these:

- **Test-first.** Write the failing test for each acceptance criterion, then the code, then refactor
  with the tests green. A fix comes with a test that failed before it. Never skip, weaken or delete a
  test to get green.
- **Latest stable versions, pinned.** Each task installs the latest stable release of what it adds
  (no previews, betas or release candidates) and pins the exact version: exact versions in the
  site's `package.json` with `bun.lock` committed, central versions in the API's
  `Directory.Packages.props` with `packages.lock.json` committed. The specs never name versions.
- **No packages from Chinese authors or repackagers.** Before adding a package, a font or a copied
  component, check who publishes it (the npm or NuGet owner, the repository owner and the
  maintainers). Anything authored, maintained or republished by a Chinese company or individual is
  not used, and neither is a fork or bundle of such a package. Record the check in the commit
  message when it is not obvious.
- **No em dash** in any copy, doc, comment or commit message. Use a comma, a period or parentheses.
  The site's text scan (T014) fails on it.
- **No mobile version of Runova** anywhere on the site (see the forbidden list).
- **Skills.** A session that lacks a skill it needs (for example an Astro or .NET skill) may find one
  from a trustworthy source, read it in full, install it into `.claude/skills/<name>/` and record it
  in `skills-lock.json` at the repo root (name, source URL, commit or version, SHA-256 of the
  files). Skills obey the package rule above.
- **Accessibility.** WCAG 2.2 AA: keyboard reachable, visible focus, labels on every control,
  severity and status never shown by color alone, and alt text on every image.
- **Copy.** Plain, direct English that a developer would write. No marketing filler, no invented
  numbers, nothing the app does not do.

## Tasks

T002 to T010 build the API (E41), T011 to T022 build the site, T023 to T025 bring news to the
Dashboard (E42), T026 packages the stack and adds CI, T027 runs every website test, and T028 runs
the repository gates, updates the docs and merges.

## Out of scope

User accounts for visitors, comments, newsletters, analytics beyond Sentry, translations, and any
page for a mobile version of Runova.
