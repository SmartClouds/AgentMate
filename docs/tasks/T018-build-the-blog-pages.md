---
id: T018
title: Build the blog pages
status: todo
epic: E40
depends: [T009, T014]
estimate: 160000
specs:
  - docs/epics/40-website.md
  - docs/website/api-contract.md
---

## Goal

A readable, indexable blog fed by the API.

## Scope

/blog (paged), /blog/<slug> and /blog/tags/<tag>, rendered on demand from the API with Cache-Control and stale-while-revalidate. BlogPosting JSON-LD, a per-post Open Graph image (generated, or the cover image), RSS at /blog/rss.xml, reading time, author, related posts, and a real 404 for an unknown slug. Tests use a fake API.

## Acceptance criteria

- [ ] List, post and tag pages render from the API with the paging from api-contract.md
- [ ] An unknown slug returns HTTP 404 with the site's 404 page
- [ ] The RSS feed validates as RSS 2.0 and lists the latest posts
- [ ] Each post has BlogPosting JSON-LD with headline, datePublished, author and image
- [ ] Responses carry the Cache-Control header set in 40-website.md

## Test plan

Write first: container tests for each page against fixture API data, the 404 case, an RSS validation test and a JSON-LD shape test. Then Playwright for paging and tag navigation against a fake API.
