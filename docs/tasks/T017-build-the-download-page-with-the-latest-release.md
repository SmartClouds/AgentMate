---
id: T017
title: Build the download page with the latest release for the visitor's system
status: in-progress
epic: E40
depends: [T010, T014]
estimate: 140000
specs:
  - docs/epics/40-website.md
  - docs/website/api-contract.md
---

## Goal

Visitors get the latest version for their own system by default, and every other build is one click away.

## Scope

/download, rendered on demand with a 5-minute cache from GET /api/v1/releases/latest, falling back to the version known at build time when the API is down. It detects the visitor's OS and architecture (User-Agent Client Hints, then the user agent) and makes that installer the main button. It lists every other platform with size, checksum and file type, plus winget install SmartClouds.Runova, system requirements and a release notes link. Nothing about mobile. SoftwareApplication JSON-LD with softwareVersion and downloadUrl. Tests use a fake API.

## Acceptance criteria

- [ ] Windows x64, macOS arm64, macOS x64 and Linux x64 user agents each get the matching asset as the main button (Playwright, one case per user agent)
- [ ] An unknown system gets the full list with no wrong default
- [ ] With the API down, the page still renders with the build-time version and a GitHub Releases link
- [ ] The JSON-LD softwareVersion equals the version shown on the page

## Test plan

Write first: unit tests for OS and architecture detection over a table of user agents and client hints, and container tests for the page with API data and with the API down. Then Playwright with each user agent against a fake API, and the forbidden-phrase scan.
