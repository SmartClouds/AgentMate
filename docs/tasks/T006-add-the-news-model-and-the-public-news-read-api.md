---
id: T006
title: Add the news model and the public news read API
status: done
epic: E41
depends: [T005]
estimate: 170000
specs:
  - docs/epics/41-website-api.md
  - docs/website/api-contract.md
---

## Goal

Anyone, the desktop app included, can list and read published technology news with its category, severity and affected technologies.

## Scope

A NewsItem entity: long id, slug, title, summary, Markdown body, rendered and sanitized HTML, category, severity, affected technologies (slug, version range, fixed-in version), CVE ids, CVSS score, source links, tags, status (draft, scheduled, published, archived), publishedAt, updatedAt and a concurrency token. Add the migration, Markdig rendering with HtmlSanitizer, and Mapperly mappers. Endpoints: GET /api/v1/news (filters category, severity, minSeverity, technology, tag, since and q; sort; page and pageSize; ETag and Cache-Control), GET /api/v1/news/{slug} (ETag, 304 on If-None-Match, 404 for anything unpublished) and GET /api/v1/technologies (the slug list). Seed data only in tests. No write endpoints yet.

## Acceptance criteria

- [ ] Only published items whose publishedAt has passed are returned, newest first by default
- [ ] Every filter in api-contract.md works alone and combined, and a pageSize over 100 returns 400 problem details
- [ ] A repeat request with If-None-Match returns 304
- [ ] Rendered HTML contains no script, iframe, event handler attribute or javascript: link
- [ ] Category and severity serialize as the lowercase strings in api-contract.md

## Test plan

Write unit tests first for the renderer and sanitizer, the filter query building and the mappers. Then integration tests against Testcontainers PostgreSQL for each filter, paging, ETag and hidden drafts, and an updated OpenAPI snapshot. Then run pnpm website-api:test.
