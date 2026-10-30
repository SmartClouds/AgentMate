---
id: T010
title: Serve the latest desktop release from GitHub Releases
status: done
epic: E41
depends: [T005]
estimate: 140000
specs:
  - docs/epics/41-website-api.md
  - docs/website/api-contract.md
---

## Goal

The site and scripts can always get the latest Runova desktop release and the right file for a platform.

## Scope

A Hangfire recurring job, every 15 minutes, that reads the latest SmartClouds/Runova release from the GitHub REST API with conditional requests (ETag) and an optional token, and stores the release and its assets in PostgreSQL. Classify each asset by platform (windows, macos, linux), architecture (x64, arm64, universal) and kind from the names electron-builder.yml produces. Leave out updater metadata (latest*.yml, blockmaps) and anything that is not the desktop app. Endpoints: GET /api/v1/releases/latest, GET /api/v1/releases/latest/assets with platform and arch filters, and GET /api/v1/releases/latest/downloads/{platform}, which answers 302 to the best asset (arch optional). Include SHA-256 checksums where the release has them. Tests use a fake GitHub.

## Acceptance criteria

- [ ] A 304 from GitHub leaves the stored release unchanged and causes no database write
- [ ] Every asset in a recorded real release response is classified, and updater metadata and blockmaps are left out
- [ ] /downloads/windows redirects to the x64 installer, /downloads/macos?arch=arm64 to the arm64 dmg, and an unknown platform gets 404 problem details
- [ ] With GitHub unreachable, the last stored release keeps being served and the failure is reported to Sentry
- [ ] No asset that is not the desktop app is ever returned

## Test plan

Write unit tests first for asset classification over recorded release JSON. Add integration tests with a fake GitHub HTTP handler for 200, 304 and failure, and for the redirect endpoint. Then run pnpm website-api:test.
