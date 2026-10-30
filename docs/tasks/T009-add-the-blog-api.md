---
id: T009
title: Add the blog API
status: todo
epic: E41
depends: [T008]
estimate: 180000
specs:
  - docs/epics/41-website-api.md
  - docs/website/api-contract.md
---

## Goal

Blog posts can be listed, read, written by editors or API clients, and scheduled.

## Scope

A Post entity: long id, slug, title, excerpt, Markdown body, rendered HTML, cover image, tags, author, status, publishedAt, reading time and a concurrency token. A Tag entity, the migration and Mapperly mappers. Endpoints: GET /api/v1/posts (tag, q, paging), GET /api/v1/posts/{slug} and GET /api/v1/tags. Editor writes through POST, PUT, PATCH and DELETE with If-Match; API clients write with the posts:write scope. POST /api/v1/media for cover images: PNG, JPEG, WebP or AVIF up to 5 MB, type sniffed from content, metadata stripped, stored in a configured folder and served under /media. Scheduled posts go out through the publish job from T007.

## Acceptance criteria

- [ ] Only published posts are listed, with the paging metadata from api-contract.md
- [ ] Write rules match the news resource: 201 with Location, 409 on a duplicate slug, 412 and 428 for If-Match
- [ ] An API client with only news:write gets 403 on post writes
- [ ] An upload with a wrong content type, a disguised file or more than 5 MB is refused with 400 or 413, and a stored JPEG has no EXIF data
- [ ] Rendered post HTML passes the same sanitizer tests as news

## Test plan

Write integration tests first for listing, reading, writes, scopes, scheduling and uploads (with fixture files, one of them a disguised file). Add unit tests for reading time and the mappers. Then run pnpm website-api:test.
