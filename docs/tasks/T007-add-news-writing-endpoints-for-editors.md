---
id: T007
title: Add news writing endpoints for editors
status: todo
epic: E41
depends: [T006]
estimate: 150000
specs:
  - docs/epics/41-website-api.md
  - docs/website/api-contract.md
---

## Goal

Editors write, schedule, update and archive news through the RESTful news resource.

## Scope

POST /api/v1/news (201 with Location). PUT and PATCH (JSON Merge Patch) on /api/v1/news/{id} with If-Match. DELETE archives the item (soft delete). Validation with the built-in .NET 10 validation: slug unique, technology slugs from the list, security news at severity low or higher, information news at info. A Hangfire job publishes scheduled items when their publishedAt arrives. Writes need the Editor or Admin role (cookie) and leave audit entries. API-client auth is T008.

## Acceptance criteria

- [ ] An Editor creates, updates and archives an item, and a signed-out caller gets 401
- [ ] A stale If-Match gets 412 and a missing If-Match gets 428
- [ ] A duplicate slug gets 409, and an unknown technology slug gets 400 with the field named in the problem details errors
- [ ] An item scheduled for the future stays out of GET /api/v1/news until the publish job runs at its time
- [ ] Every write leaves an audit entry with the user id

## Test plan

Write integration tests first for each status code, the validation rules, the publish job (run directly with a fixed clock) and the audit entries, then the code. Then run pnpm website-api:test.
