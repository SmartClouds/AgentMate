---
id: T024
title: Show news on the Dashboard
status: todo
epic: E42
depends: [T023]
estimate: 200000
specs:
  - docs/epics/42-dashboard-news.md
  - docs/website/design.md
---

## Goal

Users see the latest technology news on the Dashboard in a clear card, and notice at once when a security item affects their system.

## Scope

A News card registered in the dashboard layout store: on by default for new installs, added to existing layouts, and removable like the other cards. It lists the latest items with a category chip, a severity badge (icon, text and color), an unread dot and an 'Affects your system' badge naming the matched tool and version, with category and severity filters. Shimmer per card while loading, plus empty, offline and error states. A detail sheet shows the HTML sanitized again with DOMPurify, the affected technologies, what to do, Open on website (external link) and Mark as read. A view-all dialog with paging. SimpleTooltip instead of the title attribute, keyboard navigation, reduced motion, and all four themes.

## Acceptance criteria

- [ ] The card appears on a fresh install and is added once to an existing saved layout without moving other cards
- [ ] An affected security item is listed first, with the badge naming the tool and version
- [ ] Severity is never shown by color alone (each level has an icon and a label)
- [ ] The detail sheet strips scripts and event handlers from item HTML even when the API sends them
- [ ] Loading shows a shimmer on the card only, and offline shows the cached items with a stale note

## Test plan

Write component tests first (Testing Library) for the card states, sorting, filters, the detail sheet with hostile HTML, keyboard navigation, and the layout store migration (dashboardLayoutStore.test.ts). Then run the desktop tests for the touched folders, typecheck, and look at screenshots in Dark and Light.
