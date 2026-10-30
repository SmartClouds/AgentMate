---
id: T019
title: Build the news section with categories and severity
status: todo
epic: E40
depends: [T006, T014]
estimate: 170000
specs:
  - docs/epics/40-website.md
  - docs/website/api-contract.md
  - docs/website/design.md
---

## Goal

Visitors see the latest technology news and can tell at a glance which security items need them to update.

## Scope

/news with filter chips for category and severity that also work without JavaScript through query strings. Item cards show category, severity as icon plus text plus color (never color alone), and affected technologies with versions. Security items get a 'what to do' box with the fixed-in version and update steps. /news/<slug>, NewsArticle JSON-LD, RSS at /news/rss.xml, and a Google News sitemap at /news-sitemap.xml with items from the last two days. Rendered on demand with a short cache. Tests use a fake API.

## Acceptance criteria

- [ ] Filtering by category and severity works with and without JavaScript, and the URL keeps the filters
- [ ] Every severity level shows a distinct icon and label, and the colors meet WCAG AA contrast in Dark and Light
- [ ] A security item shows its CVE ids, affected versions and fixed-in version
- [ ] The news sitemap lists only items published in the last two days, in the Google News sitemap format
- [ ] Each item page has NewsArticle JSON-LD with headline, datePublished and dateModified

## Test plan

Write first: container tests for cards at each severity, the security box and JSON-LD, a news sitemap format test, and a contrast test over the severity tokens. Then Playwright for filters with JavaScript on and off against a fake API.
