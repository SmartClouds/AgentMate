---
id: T025
title: Add news settings, the help article and the end-to-end test
status: todo
epic: E42
depends: [T024]
estimate: 180000
specs:
  - docs/epics/42-dashboard-news.md
---

## Goal

Users control what news they see and what notifies them, the feature is documented, and the full flow is proven end to end.

## Scope

Settings > Notifications: news on or off, which categories to show, and the minimum severity that notifies. A help article at apps/desktop/src/shared/help/articles/news.md (it also appears on the website's Help, so no mobile mention and no em dash). A command palette entry. apps/desktop/e2e/news.e2e.ts against a fake news API on loopback, built like e2e/fakeSentryServer.ts.

## Acceptance criteria

- [ ] Turning news off hides the card and stops polling; changing the minimum severity changes what notifies
- [ ] news.md parses with the help parser and appears in the Help page and in its search
- [ ] news.e2e.ts passes: items show, filters work, the detail sheet opens, Mark as read sticks after a restart, a seeded technology shows the affected badge, and a matched critical item raises one notification
- [ ] Settings persist across a restart and are included in backup and restore

## Test plan

Write first: unit tests for the settings defaults and their effect on the poller and notifier, and a help articles test that includes news.md. Then the e2e spec against the fake API, run with pnpm --filter @runova/desktop test:e2e -- news.
