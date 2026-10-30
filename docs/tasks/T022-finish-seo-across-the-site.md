---
id: T022
title: Finish SEO across the site
status: todo
epic: E40
depends: [T015, T016, T017, T018, T019, T021]
estimate: 160000
specs:
  - docs/epics/40-website.md
---

## Goal

Every public page is easy to crawl and index, with correct metadata, and the site stays that way.

## Scope

A sitemap index covering the static pages plus blog and news URLs from the API; robots.txt that blocks /admin and /api; canonical and trailing slash rules; a default Open Graph image; 404 and 500 pages; a build check that every page's title and description are unique; structured data checked against schema.org types with schema-dts; llms.txt; security headers (CSP, HSTS, Referrer-Policy) from the adapter middleware; Lighthouse CI over the home page, a features page, a help article, download, a blog post and a news item.

## Acceptance criteria

- [ ] Lighthouse SEO is 100 and accessibility at least 95 on every page in the Lighthouse CI list
- [ ] The sitemap index lists every public page and no /admin or /api URL
- [ ] No two built pages share a title or a description
- [ ] Every JSON-LD block parses and matches its schema.org type
- [ ] Responses carry the CSP and HSTS headers, and the site still works under that CSP (Playwright console has no CSP errors)

## Test plan

Write first: the build-wide uniqueness check, the sitemap test against a fake API, the JSON-LD type tests, and a headers test. Then Lighthouse CI with the budgets, and a Playwright pass that fails on any CSP console error.
