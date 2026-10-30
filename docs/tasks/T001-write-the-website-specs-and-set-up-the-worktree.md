---
id: T001
title: Write the website specs and set up the worktree
status: done
epic: E40
estimate: 110000
specs:
  - docs/epics/40-website.md
  - docs/epics/41-website-api.md
  - docs/epics/42-dashboard-news.md
  - docs/website/api-contract.md
  - docs/website/design.md
---

## Goal

Turn the request into the specs every later task follows, and give the work its own git worktree as the user asked.

## Scope

Docs only, no code. Read README.md, docs/ROADMAP.md, docs/DELIVERY_STATUS.md, apps/desktop/src/renderer/src/index.css (theme tokens), apps/desktop/src/shared/help/articles (help source), apps/desktop/electron-builder.yml (release asset names) and apps/server-core/Directory.Packages.props (.NET conventions). Write docs/epics/40-website.md: architecture (apps/website/web is Astro with bun as package manager and runtime, apps/website/api is .NET 10 on PostgreSQL), the rendering mode of every route (static or on demand), one origin behind a reverse proxy (/api, /media and /hangfire go to the API), SEO rules, the list of screenshots, the forbidden-phrase list that keeps any mobile version of Runova off the site (the Deploy 'App Store' and the Android emulator feature stay allowed), and working rules: test-first, latest stable versions pinned, no packages from Chinese authors or repackagers, no em dash in copy, and a session may find and install a missing skill into .claude/skills, recorded in skills-lock.json. Write docs/epics/41-website-api.md: solution layout, Identity on long (bigint) keys, roles Admin and Editor, Sentry and OpenTelemetry, Hangfire on PostgreSQL, Mapperly, xunit v3 with Testcontainers PostgreSQL. Write docs/epics/42-dashboard-news.md: the desktop news client, the matching rules behind 'affects your system', and the dashboard card UX. Write docs/website/api-contract.md: every REST resource under /api/v1 with methods, auth, query parameters, paging, ETag and If-Match, RFC 9457 problem details, DTO shapes, news categories, severity levels (info, low, medium, high, critical), technology slugs, and the HMAC-SHA256 signing scheme for API clients with a worked test vector. Write docs/website/design.md: the app's Dark (default) and Light color tokens, fonts (Inter Variable for body text to match the app, a display face, a mono face, all self-hosted through Fontsource), and which effects to use from React Bits, Beautiful UI, BeUI, RareUI, transitions.dev, shadcn/ui and three.js, with motion and reduced-motion rules. Add E40 to E42 rows to docs/DELIVERY_STATUS.md. Commit the docs on master, then create the worktree ../Runova-website on branch website from that commit. Every later task works in that worktree.

## Acceptance criteria

- [ ] The five spec files exist in both the main checkout and the worktree, and every spec path named by the later tasks resolves
- [ ] api-contract.md lists every endpoint with method, path, auth, request body, responses and status codes, using plural nouns under /api/v1
- [ ] api-contract.md has an HMAC signing test vector (key, canonical string, expected signature) that reproduces
- [ ] design.md gives the primary, background, card, border, muted, destructive, warning and success values for Dark and Light exactly as apps/desktop/src/renderer/src/index.css has them
- [ ] No new doc uses the em dash character or mentions a mobile version of Runova
- [ ] git worktree list shows ../Runova-website on branch website

## Test plan

Run a check over the new docs: grep for the em dash character finds nothing, a link check confirms every relative link and spec path resolves, the HMAC test vector reproduces with openssl dgst -sha256 -hmac or a short script, and git worktree list shows the worktree on branch website.
