---
id: T013
title: Capture the app screens that need fake services
status: done
epic: E40
depends: [T012]
estimate: 210000
specs:
  - docs/epics/40-website.md
---

## Goal

Screenshots for every remaining feature the site explains, still from demo data only.

## Scope

Extend websiteShots.e2e.ts with: Deploy (Overview, Containers, App Store, Websites, Firewall, Backups) against the DevHost from e2e/devHost.ts; Monitoring Uptime and Errors against fake health endpoints and e2e/fakeSentryServer.ts; the Relay board with seeded task files; Token Usage from seeded local logs; Pipelines against a fake GitHub; Docker; API Client; the SSH and Remote Desktop server lists; Studio; the Help center; the AI Pet card. On the Remote page, capture only the SSH and Remote Desktop tabs so nothing about pairing a phone shows. All shots go into the same manifest.

## Acceptance criteria

- [ ] Every screenshot listed for this task in 40-website.md is written and listed in the manifest with alt text
- [ ] No captured page contains the phrases on the forbidden-phrase list (checked on page text before capture)
- [ ] The spec still runs only with RUNOVA_WEBSITE_SHOTS=1 and leaves no DevHost or fake server running afterwards
- [ ] The site manifest test from T012 passes with the new entries

## Test plan

Run the spec with the variable set, look at each new image, and run the site's manifest test. Confirm with a process check that no child process is left running.
