---
id: T015
title: Write the features section with a page per feature group
status: done
epic: E40
depends: [T013, T014]
estimate: 180000
specs:
  - docs/epics/40-website.md
  - docs/website/design.md
---

## Goal

Every feature of the app is explained on the site, with screenshots where they help.

## Scope

A features content collection (MDX) with one entry per group from the README: workspace and agent status; git, diffs and review; tests; Relay; token usage and auto-continue; Build (Blueprint, Prompt Builder, Ask AI, API Client); Agents (AI CLI Manager, Skills and Skill Security, MCP, Agent Tools); Ship (Pipelines, Deploy, Monitoring, Docker, Android); Connect (Remote, SSH, Remote Desktop, Vault); Studio; and the rest (Dashboard, status bar, notifications, help center, AI Pet, settings and proxy). Each entry says what the feature does and why it matters, shows its screenshots from the manifest, and links to the matching help articles. A /features index with a filterable grid, and breadcrumbs. Copy written fresh from the README and the help articles, with no mention of a mobile version and no em dash.

## Acceptance criteria

- [ ] Every feature listed in the README Features section maps to a features entry (test against the list in 40-website.md)
- [ ] Every screenshot reference resolves to a manifest entry, and every image has alt text
- [ ] Every feature page has a unique title and description and BreadcrumbList JSON-LD
- [ ] The forbidden-phrase and em dash scan passes over every built features page

## Test plan

Write first: the feature coverage test, the screenshot reference test, and container tests for the index filter and breadcrumbs. Then the content. Then run bun run test, build and the forbidden-phrase scan, plus a Playwright test for the grid filter.
