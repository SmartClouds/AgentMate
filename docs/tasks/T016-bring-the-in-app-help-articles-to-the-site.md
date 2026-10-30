---
id: T016
title: Bring the in-app help articles to the site
status: in-progress
epic: E40
depends: [T013, T014]
estimate: 180000
specs:
  - docs/epics/40-website.md
---

## Goal

The website's Help section shows the same guides as the app, from one source, so the two never drift.

## Scope

An Astro content loader that reads apps/desktop/src/shared/help/articles/*.md directly, with the same categories as apps/desktop/src/shared/help/parse.ts. It drops sections and lines about the mobile app by the rules in 40-website.md, turns in-app routes into links to the matching feature page, and shows the screenshot mapped to an article's route. A /help index by category, article pages with a table of contents and previous and next links, Pagefind static search, and TechArticle and BreadcrumbList JSON-LD. The app's article files are not changed.

## Acceptance criteria

- [ ] Every article in the folder becomes a page at /help/<slug>, and the counts match
- [ ] No help page mentions a mobile version of Runova, and the Android emulator content is still there
- [ ] Pagefind search finds an article by a keyword from its front matter (Playwright)
- [ ] Every internal link on every help page resolves (link check over the build)

## Test plan

Write first: unit tests for the loader and the mobile filter, using fixture articles that include a phone pairing section and an Android emulator section. Then a build-wide link check, the forbidden-phrase scan, and a Playwright test for search and navigation.
