---
id: T028
title: Run the full repository gates, update the docs and merge the worktree
status: todo
epic: E40
depends: [T027]
estimate: 230000
specs:
  - docs/epics/40-website.md
  - docs/epics/41-website-api.md
  - docs/epics/42-dashboard-news.md
  - docs/DELIVERY_STATUS.md
  - docs/ROADMAP.md
---

## Goal

The whole repository passes every gate with the website and dashboard news in it, the docs say what was built and verified, and the work is back on master.

## Scope

In the worktree, run the gates from docs/DELIVERY_STATUS.md: pnpm biome:ci, check:deprecated-code, check:deprecated-deps, build:packages, pnpm -r typecheck, pnpm test:unit (with a summary reporter, reading only the failures), the desktop build, server-core:test, and the e2e specs this work touched (news.e2e.ts, plus help and dashboard specs). Fix failures at their cause. Update README.md (a Website section, and news on the Dashboard), docs/ROADMAP.md (the website decisions), and docs/DELIVERY_STATUS.md rows E40 to E42 with what was verified and what was not. Then merge branch website into master locally, rerun the unit gate on master, and remove the worktree only after that passes. Pushing is left to the user.

## Acceptance criteria

- [ ] Every gate in docs/DELIVERY_STATUS.md passes in the worktree, and the unit gate passes again on master after the merge
- [ ] README, ROADMAP and DELIVERY_STATUS describe the website, the API and dashboard news without the em dash character
- [ ] master contains the website branch's commits, and git worktree list no longer shows ../Runova-website
- [ ] Nothing was pushed

## Test plan

Run each gate command and record its result in the handoff, fix and rerun failures, merge, rerun pnpm test:unit and pnpm website-api:test on master, then check git log and git worktree list.
