---
id: T023
title: Fetch news in the desktop main process
status: todo
epic: E42
depends: [T006]
estimate: 190000
specs:
  - docs/epics/42-dashboard-news.md
  - docs/website/api-contract.md
---

## Goal

The desktop app keeps an up-to-date, offline-safe list of news and knows which security items affect this computer.

## Scope

shared/newsTypes.ts, and IPC.news channels in shared/ipcChannels.ts with zod validation and preload methods. main/news: a client for GET /api/v1/news (base https://runovahq.com/api/v1; RUNOVA_NEWS_API_URL in development builds only) through the app's proxy-aware fetch, ETag caching, a local cache for offline use, a poll every 30 minutes while the app runs, and read and dismissed state. 'Affects your system' matching of technology slugs and version ranges against what the app already detects: its own version, Electron and Node, the AI CLIs from CLI Manager, and Git, Node.js, .NET and Docker from Dev Setup. An OS notification plus an entry in the notifications list for a matched high or critical security item. No UI.

## Acceptance criteria

- [ ] A 304 keeps the cache, and a network failure serves the cached list marked stale
- [ ] Table tests: a version inside the range marks the item affected, and a version outside it or a tool that is not installed does not
- [ ] A matched critical item notifies once, and never again after it is read or dismissed; an unmatched item never notifies
- [ ] RUNOVA_NEWS_API_URL is ignored in packaged builds
- [ ] ipcContract.test.ts and ipcChannels.test.ts pass with the new channels

## Test plan

Write Vitest tests first for the client (200, 304, failure, malformed payload rejected by zod), the matcher table, the poll scheduler with fake timers, notify-once, and the IPC handlers. Then run pnpm --filter @runova/desktop test for the touched folders and pnpm -r typecheck.
