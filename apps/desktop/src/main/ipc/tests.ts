import type {
  TestDiscovery,
  TestNode,
  TestRef,
  TestRunEvent,
  TestRunSnapshot,
  TestRunSummary,
  TestTarget,
} from '@runova/core';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { discoverWorkspaceTests } from '../tests/discovery';
import { TestRunManager } from '../tests/runner';
import { findProjectScope } from '../worktrees/resolve';
import { broadcastToWindows } from './send';

/**
 * IPC for the workspace Tests panel. Discovery is cached per project so a run resolves the same
 * tree the panel is showing, and picks from the renderer are checked against that tree before any
 * of them reach a command line.
 */

const discoveries = new Map<string, { folderPath: string; discovery: TestDiscovery }>();

const manager = new TestRunManager({
  emit: (event: TestRunEvent) => {
    broadcastToWindows(IPC.tests.onRunEvent, event);
  },
});

async function projectFolder(projectId: string): Promise<string> {
  const project = await findProjectScope(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  return project.folderPath;
}

async function discover(
  projectId: string,
): Promise<{ folderPath: string; discovery: TestDiscovery }> {
  const folderPath = await projectFolder(projectId);
  const discovery = await discoverWorkspaceTests(folderPath);
  const entry = { folderPath, discovery };
  discoveries.set(projectId, entry);
  return entry;
}

async function cached(
  projectId: string,
): Promise<{ folderPath: string; discovery: TestDiscovery }> {
  const entry = discoveries.get(projectId);
  if (entry && entry.folderPath === (await projectFolder(projectId))) return entry;
  return discover(projectId);
}

function knownFiles(node: TestNode): Set<string> {
  const files = new Set<string>();
  const walk = (entry: TestNode): void => {
    if (entry.file) files.add(entry.file);
    entry.children.forEach(walk);
  };
  walk(node);
  return files;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** Keeps only picks that name a discovered test project and files that project owns. */
function sanitizeTarget(raw: unknown, discovery: TestDiscovery): TestTarget | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<TestTarget>;
  const node = discovery.tree.find((entry) => entry.id === candidate.testProjectId);
  if (!node) return null;
  const files = knownFiles(node);
  const pickedFiles = isStringArray(candidate.files)
    ? candidate.files.filter((file) => files.has(file))
    : [];
  const pickedTests = Array.isArray(candidate.tests)
    ? candidate.tests
        .filter(
          (ref): ref is TestRef =>
            typeof ref === 'object' &&
            ref !== null &&
            typeof ref.file === 'string' &&
            files.has(ref.file) &&
            isStringArray(ref.path),
        )
        .map((ref) => ({ file: ref.file, path: [...ref.path] }))
    : [];
  const askedForSome = (candidate.files?.length ?? 0) > 0 || (candidate.tests?.length ?? 0) > 0;
  if (askedForSome && pickedFiles.length === 0 && pickedTests.length === 0) return null;
  return {
    testProjectId: node.id,
    ...(pickedFiles.length > 0 ? { files: pickedFiles } : {}),
    ...(pickedTests.length > 0 ? { tests: pickedTests } : {}),
  };
}

export function registerTestHandlers(): void {
  ipcMain.handle(IPC.tests.discover, async (_event, projectId: string): Promise<TestDiscovery> => {
    return (await discover(String(projectId))).discovery;
  });

  ipcMain.handle(
    IPC.tests.run,
    async (_event, projectId: string, targets: unknown): Promise<TestRunSummary> => {
      const id = String(projectId);
      const { folderPath, discovery } = await cached(id);
      const list = Array.isArray(targets) ? targets : null;
      const picked = (list ?? [])
        .map((target) => sanitizeTarget(target, discovery))
        .filter((target): target is TestTarget => target !== null);
      const runAll = list !== null && list.length === 0 && discovery.projects.length > 0;
      if (!runAll && picked.length === 0) {
        throw new Error('Nothing to run: none of the picked tests are in this project anymore.');
      }
      return manager.start({ projectId: id, folderPath, discovery, targets: picked });
    },
  );

  ipcMain.handle(IPC.tests.cancel, (_event, projectId: string): boolean =>
    manager.cancel(String(projectId)),
  );

  ipcMain.handle(IPC.tests.lastRun, (_event, projectId: string): TestRunSnapshot | null =>
    manager.lastRun(String(projectId)),
  );

  ipcMain.handle(
    IPC.tests.command,
    async (_event, projectId: string, target: unknown): Promise<string | null> => {
      const { folderPath, discovery } = await cached(String(projectId));
      const clean = sanitizeTarget(target, discovery);
      return clean ? manager.describeCommand(folderPath, discovery, clean) : null;
    },
  );
}
