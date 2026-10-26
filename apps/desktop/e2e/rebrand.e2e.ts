import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, createProject, type LaunchedApp, launchApp } from './app';

/**
 * An install from before the app was renamed: its profile sits in a folder named after the old
 * name, and its project has the old project folder and run-commands entry. Starting Runova moves
 * all of it over. The app's "app data" root is pointed at the test's own folder, so this machine's
 * real profiles are never looked at.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test('a profile and project from before the rename move over on the first start', async () => {
  // A first run makes a real profile with a project in it.
  const first = await launchApp({ settings: {} });
  await createProject(first);
  await closeApp(first.app, first.root);

  // Turn it into one from before the rename.
  const appData = join(first.root, 'appdata');
  mkdirSync(appData, { recursive: true });
  const legacyProfile = join(appData, 'AgentMate Dev'); // legacy-name
  renameSync(first.userDataDir, legacyProfile);
  const legacyDir = join(first.projectDir, '.agentmate'); // legacy-name
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'TASKS.md'), '# Tasks\n');
  writeFileSync(join(legacyDir, 'run-commands-mcp.cjs'), '// old bridge\n');
  writeFileSync(
    join(first.projectDir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        agentmate: { command: 'node', args: [join(legacyDir, 'run-commands-mcp.cjs')] }, // legacy-name
        mine: { command: 'my-own-server' },
      },
    }),
  );

  launched = await launchApp({
    reuseRoot: first.root,
    env: { RUNOVA_USER_DATA_DIR: '', RUNOVA_E2E_APP_DATA: appData },
  });
  const { page } = launched;
  const profile = join(appData, 'Runova Dev');

  // The profile folder was renamed, so the project is still there.
  expect(existsSync(join(profile, 'data', 'projects.json'))).toBe(true);
  expect(existsSync(legacyProfile)).toBe(false);
  await page.evaluate(() => {
    location.hash = '#/projects';
  });
  await expect(page.getByText('e2e project').first()).toBeVisible({ timeout: 20_000 });

  // The project's own files follow in the background once the app is up.
  await expect
    .poll(() => existsSync(join(first.projectDir, '.runova', 'TASKS.md')), { timeout: 20_000 })
    .toBe(true);
  expect(existsSync(legacyDir)).toBe(false);
  await expect
    .poll(
      () =>
        Object.keys(
          JSON.parse(readFileSync(join(first.projectDir, '.mcp.json'), 'utf-8')).mcpServers ?? {},
        ).sort(),
      { timeout: 20_000 },
    )
    .toEqual(['mine', 'runova']);
  expect(readFileSync(join(first.projectDir, '.runova', 'run-commands-mcp.cjs'), 'utf-8')).not.toBe(
    '// old bridge\n',
  );
  // Nothing was left to do with secrets on this profile, so the follow-ups are recorded as done.
  await expect
    .poll(() => JSON.parse(readFileSync(join(profile, 'rebrand.json'), 'utf-8')), {
      timeout: 20_000,
    })
    .toMatchObject({ secrets: 'done', hooks: 'done' });
});
