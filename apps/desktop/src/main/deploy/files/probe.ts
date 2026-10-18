import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesErrorCode, filesErrorMessage } from '../../../shared/deployFilesErrors';
import type {
  FileSiteCapabilities,
  FilesBrowseResult,
  FilesTestResult,
  FilesTestStep,
  FilesTestStepResult,
} from '../../../shared/deployFilesTypes';
import { FilesTransportError } from './transport/errors';
import { joinRemote, normalizeRemote, parentOf } from './transport/remotePath';
import type { OpenRemoteFiles, RemoteFiles } from './transport/types';
import type { FilesConnectTarget } from './types';

/**
 * Test connection for an FTP or SFTP site (E23): log in, find the folder, write a probe file,
 * replace it, read its time and remove it again. Each step lands in a checklist the site form
 * shows, with a plain reason when it failed, and what was learned (can a file be replaced in one
 * step, how are times read) is kept as the site's capabilities. The probe file is removed
 * whatever happened before.
 */

export interface TestConnectionOptions {
  now?: () => number;
  /** The 8 hex digits in the probe file's name. */
  randomHex?: () => string;
}

const STEPS: FilesTestStep[] = ['reach', 'login', 'folder', 'write', 'replace', 'time', 'cleanup'];
/** Failures that happen before the server answered at all. */
const UNREACHED = new Set(['unreachable', 'timeout']);

export async function testConnection(
  target: FilesConnectTarget,
  open: OpenRemoteFiles,
  options: TestConnectionOptions = {},
): Promise<FilesTestResult> {
  const now = options.now ?? Date.now;
  const steps = new Map<FilesTestStep, FilesTestStepResult>(
    STEPS.map((step) => [step, { step, status: 'skipped', message: null }]),
  );
  const result: FilesTestResult = {
    ok: false,
    steps: [],
    capabilities: null,
    remoteRoot: null,
    hostKey: null,
    certificate: null,
    error: null,
  };
  const pass = (step: FilesTestStep, message: string | null = null, warn = false): void => {
    steps.set(step, { step, status: warn ? 'warning' : 'ok', message });
  };
  const fail = (step: FilesTestStep, error: unknown): void => {
    const message = filesErrorMessage(error);
    steps.set(step, { step, status: 'failed', message });
    result.error ??= { code: filesErrorCode(error) ?? 'server', message };
    if (error instanceof FilesTransportError) {
      result.hostKey ??= error.hostKey;
      result.certificate ??= error.certificate;
    }
  };
  const finish = (): FilesTestResult => {
    result.steps = STEPS.map((step) => steps.get(step) as FilesTestStepResult);
    result.ok = result.steps.every((step) => step.status !== 'failed');
    return result;
  };

  let remote: RemoteFiles;
  try {
    // A login of its own even for a saved server, so the test proves a new login gets in.
    remote = await open(target, { purpose: 'run' });
    pass('reach');
    pass('login');
  } catch (error) {
    if (UNREACHED.has(filesErrorCode(error) ?? '')) {
      fail('reach', error);
    } else {
      pass('reach');
      fail('login', error);
    }
    return finish();
  }

  const scratch = await mkdtemp(join(tmpdir(), 'agentmate-probe-'));
  try {
    let root: string;
    try {
      root = await remote.realpath(target.remoteRoot);
      if (!(await remote.stat(root))?.isDirectory) {
        throw new FilesTransportError(
          'remoteFolderMissing',
          `${target.remoteRoot} is not a folder on the server.`,
        );
      }
      result.remoteRoot = root;
      pass('folder');
    } catch (error) {
      fail('folder', asMissingFolder(error, target));
      return finish();
    }

    const probe = joinRemote(root, `agentmate-probe-${options.randomHex?.() ?? randomHex()}.txt`);
    const put = async (content: string) => {
      const path = join(scratch, `probe-${content.length}`);
      await writeFile(path, content);
      return remote.putFile(path, probe, {
        sha256: createHash('sha256').update(content).digest('hex'),
        size: Buffer.byteLength(content),
      });
    };

    let atomic: boolean | null = null;
    let written = false;
    try {
      await put('AgentMate checks that it can write here. This file is removed right away.\n');
      written = true;
      pass('write');
    } catch (error) {
      fail('write', error);
    }
    if (written) {
      try {
        atomic = (await put('AgentMate checks that it can replace a file here.\n')).atomic;
        if (atomic) pass('replace');
        else {
          pass(
            'replace',
            'This server cannot replace a file in one step, so while a deploy replaces a file it ' +
              'is missing for a moment.',
            true,
          );
        }
      } catch (error) {
        fail('replace', error);
      }
    }

    let capabilities: FileSiteCapabilities | null = null;
    try {
      const reported = await remote.capabilities();
      let mtime = reported.mtime;
      // A server that claims times but gives none for the file just written has none to use.
      if (written && mtime !== 'none' && (await remote.stat(probe))?.mtimeMs == null) {
        mtime = 'none';
      }
      capabilities = {
        atomicReplace: atomic ?? reported.atomicReplace,
        mtime,
        checkedAt: now(),
      };
      if (mtime === 'none') {
        pass(
          'time',
          'This server does not say when a file last changed, so changes made on the server are ' +
            'judged by size alone.',
          true,
        );
      } else pass('time');
    } catch (error) {
      fail('time', error);
    }
    result.capabilities = capabilities;

    // Always attempted once a write was tried: a refused write can still leave a file.
    try {
      await remote.remove(probe);
      pass('cleanup');
    } catch (error) {
      pass(
        'cleanup',
        `The test file ${probe} could not be removed (${filesErrorMessage(error)}). Remove it by hand.`,
        true,
      );
    }
    return finish();
  } finally {
    await remote.close().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

function randomHex(): string {
  return randomBytes(4).toString('hex');
}

/** A missing folder in words that say what to do; other failures pass as they are. */
function asMissingFolder(error: unknown, target: FilesConnectTarget): unknown {
  if (filesErrorCode(error) !== 'remoteFolderMissing') return error;
  return new FilesTransportError(
    'remoteFolderMissing',
    `${target.remoteRoot} is not a folder on the server. Check the path, or create it first.`,
  );
}

/**
 * The folders inside `path` on the server, for the remote folder picker. Null starts in the
 * folder the login lands in.
 */
export async function browseRemote(
  remote: RemoteFiles,
  path: string | null,
): Promise<FilesBrowseResult> {
  const folder =
    path === null || !path.startsWith('/')
      ? await remote.realpath(path ?? '.')
      : normalizeRemote(path);
  const entries = await remote.list(folder);
  if (!entries) {
    throw new FilesTransportError(
      'remoteFolderMissing',
      `${folder} is not a folder on the server.`,
    );
  }
  return {
    path: folder,
    parent: parentOf(folder),
    folders: entries
      .filter((entry) => entry.isDirectory)
      .map((entry) => ({ name: entry.name, path: entry.path }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
      ),
  };
}
