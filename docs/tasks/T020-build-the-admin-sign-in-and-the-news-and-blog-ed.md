---
id: T020
title: Build the admin sign-in and the news and blog editors
status: todo
epic: E40
depends: [T018, T019]
estimate: 200000
specs:
  - docs/epics/40-website.md
  - docs/website/api-contract.md
---

## Goal

Editors sign in on the site and write news and blog posts there.

## Scope

/admin pages rendered on demand, noindex and kept out of the sitemap, built as React islands with shadcn/ui. Sign-in with two-factor, and sign-out. A news list and editor: category, severity, a technologies picker fed by /api/v1/technologies, CVE ids, Markdown with live preview, and scheduling. A blog list and editor: cover upload, tags and scheduling. Saves send If-Match and show a conflict dialog on 412. The antiforgery token goes on every unsafe call. Calls go to the API on the same origin.

## Acceptance criteria

- [ ] Signed-out visits to /admin pages redirect to sign-in, and every admin page has noindex and is absent from the sitemap
- [ ] An Editor signs in with a TOTP code, writes a news item and a post, and both appear on /news and /blog
- [ ] Saving over someone else's newer edit shows the conflict dialog instead of overwriting
- [ ] Every form is usable by keyboard alone, and field errors from problem details show next to their fields

## Test plan

Write first: component tests for the editors (validation display, conflict dialog, preview). Then Playwright against the real API started with Testcontainers PostgreSQL or the dev compose stack: sign-in with TOTP, create, edit, schedule, the conflict case, and a keyboard-only pass.
