import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp, openWorkspace } from './app';

/**
 * Relay (E26) through the real app: main starts each leg's terminal, the fake `claude`
 * (fixtures/fakeRelayClaude.cjs) runs the relay hooks it is given, writes the handoff its scenario
 * asks for and goes idle at its prompt, and the relay ticks the task files over. The fake logs
 * everything it does to FAKE_RELAY_LOG, so the tests can see which hooks answered what.
 */

const FAKE_CLAUDE = join(__dirname, 'fixtures', 'fakeRelayClaude.cjs');

let launched: LaunchedApp | undefined;

// biome-ignore lint/correctness/noEmptyPattern: Playwright wants its fixtures destructured
test.afterEach(async ({}, info) => {
  if (launched && info.status !== info.expectedStatus) {
    // The temp folder goes with the app, so what the fake did is kept with the failure.
    const log = join(launched.projectDir, '.fake-relay.log');
    if (existsSync(log)) await info.attach('fake-relay.log', { path: log });
    const runs = await launched.page
      .evaluate(async () => {
        const api = (
          window as unknown as {
            agentmat: {
              projects: { list(): Promise<{ id: string }[]> };
              relay: { runs(id: string): Promise<unknown[]> };
            };
          }
        ).agentmat;
        const projects = await api.projects.list();
        return Promise.all(projects.map((project) => api.relay.runs(project.id)));
      })
      .catch((error: unknown) => String(error));
    await info.attach('relay-runs.json', { body: JSON.stringify(runs, null, 2) });
  }
  await launched?.close();
  launched = undefined;
});

interface FakeEntry {
  kind: string;
  taskId?: string;
  legNo?: number;
  outcome?: string;
  by?: string;
  mode?: string;
  args?: string[];
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function taskFile(id: string, title: string, order: number, depends: string[] = []): string {
  return [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    'status: todo',
    'epic: E01',
    `order: ${order}`,
    `depends: [${depends.join(', ')}]`,
    'estimate: 40000',
    'budget: 200000',
    'specs: []',
    '---',
    '',
    '## Goal',
    `${title}.`,
    '',
    '## Acceptance criteria',
    '- [ ] It works.',
    '',
  ].join('\n');
}

function seedTasks(projectDir: string, tasks: [string, string, string[]?][]): void {
  tasks.forEach(([id, title, depends], index) => {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    write(projectDir, `docs/tasks/${id}-${slug}.md`, taskFile(id, title, index + 1, depends));
  });
}

function statusOf(projectDir: string, id: string): string | null {
  const folder = join(projectDir, 'docs', 'tasks');
  if (!existsSync(folder)) return null;
  const file = readdirSync(folder).find((name) => name.startsWith(`${id}-`));
  if (!file) return null;
  return /^status:\s*(\S+)/m.exec(readFileSync(join(folder, file), 'utf-8'))?.[1] ?? null;
}

/** What the fake `claude` did, in order. It logs into the folder it runs in. */
function fakeLog(projectDir: string): FakeEntry[] {
  const file = join(projectDir, '.fake-relay.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeEntry);
}

function launchRelayApp(): Promise<LaunchedApp> {
  return launchApp({ settings: { defaultCliId: 'claude-code' }, claudeScript: FAKE_CLAUDE });
}

type RelayApi = {
  relay: {
    start(input: unknown): Promise<{ ok: boolean; error?: string; run?: { id: string } }>;
    runs(projectId: string): Promise<{ id: string; status: string; pauseReason: string | null }[]>;
    applyProposal(projectId: string, proposal: unknown): Promise<unknown>;
    decompose(input: unknown): Promise<{ ok: boolean; error?: string; proposal?: unknown }>;
  };
};

async function startRelay(page: Page, input: Record<string, unknown>): Promise<string> {
  const result = await page.evaluate(
    (payload) => (window as unknown as { agentmat: RelayApi }).agentmat.relay.start(payload),
    input,
  );
  expect(result.ok, result.error).toBe(true);
  return result.run?.id ?? '';
}

async function runsOf(page: Page, projectId: string) {
  return page.evaluate(
    (id) => (window as unknown as { agentmat: RelayApi }).agentmat.relay.runs(id),
    projectId,
  );
}

async function openTasksTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Tasks' }).click();
  await expect(page.getByRole('list', { name: 'Relay track' })).toBeVisible();
}

test('runs two tasks in order, rolling the second over into a new session', async () => {
  test.setTimeout(180_000);
  launched = await launchRelayApp();
  const { page, projectDir } = launched;
  seedTasks(projectDir, [
    ['T001', 'Board columns', []],
    ['T002', 'Card moves', ['T001']],
  ]);
  write(projectDir, '.fake-relay.json', JSON.stringify({ legs: { T002: ['continue', 'done'] } }));
  const projectId = await openWorkspace(launched);
  await openTasksTab(page);
  await expect(page.getByRole('listitem', { name: /T001 Board columns/ })).toBeVisible();

  await page.getByRole('button', { name: 'Run relay' }).first().click();

  await expect.poll(() => statusOf(projectDir, 'T001'), { timeout: 60_000 }).toBe('done');
  await expect.poll(() => statusOf(projectDir, 'T002'), { timeout: 90_000 }).toBe('done');

  const launches = launched.claudeLaunches().filter((line) => line.includes('AgentMate Relay'));
  expect(launches).toHaveLength(3);
  expect(launches[0]).toContain('task T001');
  expect(launches[1]).toMatch(/task T002 .*session 1/);
  expect(launches[2]).toMatch(/task T002 .*session 2/);
  // Every leg gets the relay hooks, and none of them the user's saved launch defaults.
  for (const line of launches) expect(line).toContain('claude-relay-settings.json');

  await expect(page.getByRole('listitem', { name: /T002 Card moves, Done/ })).toBeVisible();
  await expect.poll(async () => (await runsOf(page, projectId))[0]?.status).toBe('done');
  const handoff = readFileSync(join(projectDir, 'docs/tasks/handoffs/T002.md'), 'utf-8');
  expect(handoff).toContain('leg: 2');
});

test('tells a session near its budget to hand off, and finishes the task in a fresh one', async () => {
  test.setTimeout(150_000);
  launched = await launchRelayApp();
  const { page, projectDir } = launched;
  seedTasks(projectDir, [['T001', 'Patient search', []]]);
  // 170K of a 200K budget is past the guard (80%); the second session starts small again.
  write(projectDir, '.fake-relay.json', JSON.stringify({ context: { T001: [170_000, 20_000] } }));
  const projectId = await openWorkspace(launched);
  await startRelay(page, { projectId, trigger: { kind: 'now' } });

  await expect.poll(() => statusOf(projectDir, 'T001'), { timeout: 90_000 }).toBe('done');
  const log = fakeLog(projectDir);
  const guard = log.find((entry) => entry.kind === 'guard') as FakeEntry & { text?: string };
  expect(guard?.text).toMatch(/handoff/i);
  expect(log.filter((entry) => entry.kind === 'handoff').map((entry) => entry.outcome)).toEqual([
    'continue',
    'done',
  ]);
  const launches = launched.claudeLaunches().filter((line) => line.includes('AgentMate Relay'));
  expect(launches).toHaveLength(2);
  expect(launches[1]).toMatch(/session 2/);
});

test('pauses on a blocked handoff and leaves the task blocked', async () => {
  test.setTimeout(120_000);
  launched = await launchRelayApp();
  const { page, projectDir } = launched;
  seedTasks(projectDir, [
    ['T001', 'Pick a database', []],
    ['T002', 'Store patients', ['T001']],
  ]);
  write(projectDir, '.fake-relay.json', JSON.stringify({ legs: { T001: ['blocked'] } }));
  const projectId = await openWorkspace(launched);
  await startRelay(page, { projectId, trigger: { kind: 'now' } });

  await expect.poll(() => statusOf(projectDir, 'T001'), { timeout: 60_000 }).toBe('blocked');
  await expect
    .poll(async () => (await runsOf(page, projectId))[0]?.status, { timeout: 30_000 })
    .toBe('paused');
  expect(statusOf(projectDir, 'T002')).toBe('todo');
  const launches = launched.claudeLaunches().filter((line) => line.includes('AgentMate Relay'));
  expect(launches).toHaveLength(1);
});

test('approves a clean plan through the hook and switches the session to auto mode', async () => {
  test.setTimeout(120_000);
  launched = await launchRelayApp();
  const { page, projectDir } = launched;
  seedTasks(projectDir, [['T001', 'Search page', []]]);
  write(projectDir, '.fake-relay.json', JSON.stringify({}));
  const projectId = await openWorkspace(launched);
  await startRelay(page, {
    projectId,
    trigger: { kind: 'now' },
    options: { planFirst: true, afterPlanMode: 'auto' },
  });

  await expect.poll(() => statusOf(projectDir, 'T001'), { timeout: 60_000 }).toBe('done');
  const launch = launched.claudeLaunches().find((line) => line.includes('AgentMate Relay')) ?? '';
  expect(launch).toContain('--permission-mode plan');
  const approval = fakeLog(projectDir).find((entry) => entry.kind === 'plan-approved');
  expect(approval).toMatchObject({ by: 'hook', mode: 'auto' });
});

test('holds a plan with open questions for the user', async () => {
  test.setTimeout(120_000);
  launched = await launchRelayApp();
  const { page, projectDir } = launched;
  seedTasks(projectDir, [['T001', 'Search page', []]]);
  write(projectDir, '.fake-relay.json', JSON.stringify({ plan: { T001: 'questions' } }));
  const projectId = await openWorkspace(launched);
  await startRelay(page, { projectId, trigger: { kind: 'now' }, options: { planFirst: true } });

  await expect
    .poll(() => fakeLog(projectDir).some((entry) => entry.kind === 'plan-waiting'), {
      timeout: 60_000,
    })
    .toBe(true);
  // Long enough for a wrong approval (by hook or by typing the menu digit) to have happened.
  await page.waitForTimeout(5_000);
  expect(fakeLog(projectDir).some((entry) => entry.kind === 'plan-approved')).toBe(false);
  expect(statusOf(projectDir, 'T001')).toBe('in-progress');
});

test('splits a request with the planner and runs it after a task the relay is working on', async () => {
  test.setTimeout(180_000);
  launched = await launchRelayApp();
  const { page, projectDir } = launched;
  seedTasks(projectDir, [['T001', 'Login', []]]);
  write(
    projectDir,
    '.fake-relay.json',
    JSON.stringify({
      // T001 works long enough for the split to be planned and scheduled behind it.
      delay: { T001: 12_000 },
      proposal: {
        summary: 'Two tasks for search.',
        add: [
          { id: 'T002', title: 'Search API', depends: ['T001'], estimate: 60000 },
          { id: 'T003', title: 'Search page', depends: ['T002'], estimate: 80000 },
        ],
        change: [],
        split: [],
        remove: [],
      },
    }),
  );
  const projectId = await openWorkspace(launched);
  await startRelay(page, { projectId, trigger: { kind: 'now' } });
  await expect.poll(() => statusOf(projectDir, 'T001'), { timeout: 30_000 }).toBe('in-progress');

  const planned = await page.evaluate(
    (id) =>
      (window as unknown as { agentmat: RelayApi }).agentmat.relay.decompose({
        requestId: 'split-e2e',
        projectId: id,
        request: 'Add patient search with an API and a page.',
        cliId: 'claude-code',
      }),
    projectId,
  );
  expect(planned.ok, planned.error).toBe(true);
  await page.evaluate(
    ({ id, proposal }) =>
      (window as unknown as { agentmat: RelayApi }).agentmat.relay.applyProposal(id, proposal),
    { id: projectId, proposal: planned.proposal },
  );
  expect(statusOf(projectDir, 'T003')).toBe('todo');
  const runId = await startRelay(page, {
    projectId,
    only: ['T002', 'T003'],
    trigger: { kind: 'after-task', projectId, taskId: 'T001' },
  });
  // The split joins the relay that runs T001 rather than starting a second one.
  expect((await runsOf(page, projectId)).map((run) => run.id)).toEqual([runId]);

  await expect.poll(() => statusOf(projectDir, 'T003'), { timeout: 120_000 }).toBe('done');
  const order = fakeLog(projectDir)
    .filter((entry) => entry.kind === 'launch' && entry.taskId)
    .map((entry) => entry.taskId);
  expect(order).toEqual(['T001', 'T002', 'T003']);
  await openTasksTab(page);
  await expect(page.getByRole('listitem', { name: /T003 Search page, Done/ })).toBeVisible();
});

test('picks up a project in progress, then carries on from the half-done task', async () => {
  test.setTimeout(150_000);
  launched = await launchRelayApp();
  const { page, projectDir } = launched;
  write(
    projectDir,
    '.fake-relay.json',
    JSON.stringify({
      proposal: {
        summary: 'Login is built and search is half done.',
        add: [
          {
            id: 'T001',
            title: 'Login',
            status: 'done',
            acceptance: ['Signs in with a password'],
            handoff: { done: 'src/auth.js, covered by auth.test.js.' },
          },
          {
            id: 'T002',
            title: 'Search',
            depends: ['T001'],
            estimate: 60000,
            handoff: { done: 'The search API.', next: 'Build the search page.' },
          },
          { id: 'T003', title: 'Export', depends: ['T002'], estimate: 40000 },
        ],
        change: [],
        split: [],
        remove: [],
      },
    }),
  );
  await openWorkspace(launched);
  await page.getByRole('tab', { name: 'Tasks' }).click();
  await page.getByRole('button', { name: 'Plan the rest with AI' }).click();

  const dialog = page.getByRole('dialog', { name: 'Pick up a project in progress' });
  const plan = dialog.getByRole('button', { name: 'Plan the rest' });
  await expect(plan).toBeEnabled({ timeout: 15_000 });
  await plan.click();
  await expect(
    dialog.getByRole('img', { name: 'Where the project stands' }),
  ).toHaveAccessibleDescription('1 finished, 1 half done, 1 to do', { timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Apply 3 changes' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('list', { name: 'Relay track' })).toBeVisible();
  await expect(page.getByText('1 of 3 done')).toBeVisible();
  expect(statusOf(projectDir, 'T001')).toBe('done');
  expect(existsSync(join(projectDir, 'docs/tasks/RELAY.md'))).toBe(true);
  expect(readFileSync(join(projectDir, 'docs/tasks/handoffs/T002.md'), 'utf-8')).toContain(
    'Build the search page.',
  );

  await page.getByRole('button', { name: 'Run relay' }).first().click();
  await expect.poll(() => statusOf(projectDir, 'T003'), { timeout: 90_000 }).toBe('done');
  const launches = launched.claudeLaunches().filter((line) => line.includes('AgentMate Relay'));
  // The finished task needs no session; the half-done one is told to build on its handoff.
  expect(launches).toHaveLength(2);
  expect(launches[0]).toContain('task T002');
  expect(launches[0]).toContain('already records work');
  expect(launches[1]).toContain('task T003');
});
