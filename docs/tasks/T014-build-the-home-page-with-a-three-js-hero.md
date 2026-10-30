---
id: T014
title: Build the home page with a three.js hero
status: done
epic: E40
depends: [T012]
estimate: 190000
specs:
  - docs/epics/40-website.md
  - docs/website/design.md
---

## Goal

A striking, fast home page that explains Runova and sends visitors to download it.

## Scope

src/pages/index.astro. A hero with a three.js scene (the runway and star from the logo, in the token colors), loaded as a client:visible island after first paint and paused off screen, with a static image instead under reduced motion, without WebGL, or on low-end devices. The headline and the ADE explanation, written from the README. Feature highlight sections with screenshots through astro:assets (AVIF and WebP, width and height set, lazy below the fold). Effects from the listed libraries only where design.md allows. A download call to action linking to /download. View transitions between pages. SoftwareApplication and Organization JSON-LD. A shared test helper that scans built HTML for the forbidden phrases and the em dash, used by every page task after this one.

## Acceptance criteria

- [ ] Lighthouse on the built home page: performance at least 90 on mobile emulation, accessibility at least 95, best practices at least 95, SEO 100
- [ ] The three.js chunk loads only once the hero is visible, and with reduced motion or no WebGL the fallback image shows (Playwright)
- [ ] CLS under 0.1 and LCP under 2.5 s in the Lighthouse run
- [ ] The forbidden-phrase and em dash scan passes over the built home page

## Test plan

Write first: container tests for the sections and JSON-LD, Playwright tests for the lazy hero and both fallbacks, and the forbidden-phrase scan. Add a Lighthouse CI config (lighthouserc) with the budgets above and run it against bun run preview.
