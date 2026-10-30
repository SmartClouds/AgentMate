---
id: T012
title: Build the app screenshot harness and capture the core screens
status: done
epic: E40
depends: [T011]
estimate: 200000
specs:
  - docs/epics/40-website.md
  - docs/website/design.md
---

## Goal

Real screenshots of the app, made from demo data and reproducible, for the site to show.

## Scope

An opt-in Playwright spec, apps/desktop/e2e/websiteShots.e2e.ts, that runs only with RUNOVA_WEBSITE_SHOTS=1 so CI skips it, built on the existing e2e launcher in e2e/app.ts. It writes a demo seed into a fresh user data folder: the made-up Northwind shop from the README, with projects, prompt history, vault entries, skills and settings. It captures Dashboard, Workspace (an agent pane, a diff and the git panel), Projects, Project detail, Blueprint, Prompt Builder, AI CLI Manager, Skills and Skill Security, MCP, Agent Tools, Vault, Settings, and the same workspace in Dark, Light, VS Code Dark and VS 2026, at 1600x1000 and 2x scale. Output goes to apps/website/web/src/assets/screenshots/ with a manifest.json (name, route, theme, alt text). Nothing from the real machine shows: no home paths, user names or tokens. Deploy, Monitoring, Relay, Usage, Pipelines, Studio and the rest are T013.

## Acceptance criteria

- [ ] With RUNOVA_WEBSITE_SHOTS=1 the spec writes every screenshot listed for this task in 40-website.md, plus the manifest
- [ ] Without the variable the spec is skipped, and the normal e2e run is unchanged
- [ ] Before each capture the spec checks the page shows only seeded demo data, never the user data folder path or the OS user name
- [ ] Every manifest entry has alt text and an existing image file

## Test plan

The spec itself, run once with the variable set and the images looked at. Add a site unit test that every manifest entry points at an existing file and has alt text. Then run the desktop e2e list without the variable to confirm the spec is skipped.
