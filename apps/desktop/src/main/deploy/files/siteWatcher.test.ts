import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFolderWatcher, type FolderWatcherDeps, type WatchHandle } from './siteWatcher';

/**
 * The deploy folder watcher: a burst of writes settles once, a tool writing nonstop still
 * settles every so often, version control and dependencies are ignored, and where watching
 * is unreliable (Linux, or after a Windows overflow) the folder is polled instead.
 */

interface FakeHandle extends WatchHandle {
  listener: (event: string, file: string | null) => void;
  errorListeners: ((error: Error) => void)[];
  closed: boolean;
}

function fakeWatch() {
  const handles: FakeHandle[] = [];
  let failNext: NodeJS.ErrnoException | null = null;
  const watch = vi.fn(
    (_root: string, _options: { recursive: boolean }, listener: FakeHandle['listener']) => {
      if (failNext) {
        const error = failNext;
        throw error;
      }
      const handle: FakeHandle = {
        listener,
        errorListeners: [],
        closed: false,
        on(event, callback) {
          if (event === 'error') this.errorListeners.push(callback);
          return this;
        },
        close() {
          this.closed = true;
        },
      };
      handles.push(handle);
      return handle;
    },
  );
  return {
    watch,
    handles,
    emit: (file: string | null) => handles.at(-1)?.listener('change', file),
    overflow: () => {
      for (const callback of handles.at(-1)?.errorListeners ?? []) callback(new Error('overflow'));
    },
    throwOnWatch: (code: string | null) => {
      failNext = code ? Object.assign(new Error(code), { code }) : null;
    },
  };
}

function deps(
  watch: ReturnType<typeof fakeWatch>,
  platform: NodeJS.Platform = 'win32',
): FolderWatcherDeps {
  return {
    watch: watch.watch,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    now: () => Date.now(),
    platform,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('watching', () => {
  it('watches the whole folder', () => {
    const fake = fakeWatch();
    const watcher = createFolderWatcher('/site', vi.fn(), deps(fake));
    expect(fake.watch).toHaveBeenCalledWith('/site', { recursive: true }, expect.any(Function));
    watcher.close();
  });

  it('settles once after a burst of writes', () => {
    const fake = fakeWatch();
    const onSettle = vi.fn();
    const watcher = createFolderWatcher('/site', onSettle, deps(fake));
    for (let index = 0; index < 5; index += 1) {
      fake.emit(`file${index}.html`);
      vi.advanceTimersByTime(50);
    }
    expect(onSettle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith('change');
    vi.advanceTimersByTime(5000);
    expect(onSettle).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it('still settles at the max wait while writes never stop', () => {
    const fake = fakeWatch();
    const onSettle = vi.fn();
    const watcher = createFolderWatcher('/site', onSettle, deps(fake));
    for (let elapsed = 0; elapsed < 1500; elapsed += 100) {
      fake.emit('busy.log');
      vi.advanceTimersByTime(100);
    }
    expect(onSettle).toHaveBeenCalledTimes(1);
    for (let elapsed = 0; elapsed < 1500; elapsed += 100) {
      fake.emit('busy.log');
      vi.advanceTimersByTime(100);
    }
    expect(onSettle).toHaveBeenCalledTimes(2);
    watcher.close();
  });

  it('ignores version control and dependencies', () => {
    const fake = fakeWatch();
    const onSettle = vi.fn();
    const watcher = createFolderWatcher('/site', onSettle, deps(fake));
    fake.emit('node_modules/pkg/index.js');
    fake.emit('.git/index');
    fake.emit('app\\node_modules\\pkg\\index.js');
    vi.advanceTimersByTime(2000);
    expect(onSettle).not.toHaveBeenCalled();
    fake.emit('node_modules_notes.txt');
    vi.advanceTimersByTime(300);
    expect(onSettle).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it('settles for build output, since a deploy folder often lives there', () => {
    for (const file of [
      'dist/index.html',
      'build\\app.js',
      'out/page.html',
      'assets\\.cache\\x.bin',
      'deep/__pycache__/m.pyc',
    ]) {
      const fake = fakeWatch();
      const onSettle = vi.fn();
      const watcher = createFolderWatcher('/site', onSettle, deps(fake));
      fake.emit(file);
      vi.advanceTimersByTime(300);
      expect(onSettle, file).toHaveBeenCalledWith('change');
      watcher.close();
    }
  });

  it('settles on an event that names no file', () => {
    const fake = fakeWatch();
    const onSettle = vi.fn();
    const watcher = createFolderWatcher('/site', onSettle, deps(fake));
    fake.emit(null);
    vi.advanceTimersByTime(300);
    expect(onSettle).toHaveBeenCalledWith('change');
    watcher.close();
  });

  it('keeps going when the callback throws', () => {
    const fake = fakeWatch();
    const onSettle = vi.fn(() => {
      throw new Error('walk failed');
    });
    const watcher = createFolderWatcher('/site', onSettle, deps(fake));
    fake.emit('a.html');
    vi.advanceTimersByTime(300);
    fake.emit('b.html');
    vi.advanceTimersByTime(300);
    expect(onSettle).toHaveBeenCalledTimes(2);
    watcher.close();
  });
});

describe('falling back to polling', () => {
  it('polls after a watch error, then tries watching again', () => {
    const fake = fakeWatch();
    const onSettle = vi.fn();
    const watcher = createFolderWatcher('/site', onSettle, deps(fake));
    fake.overflow();
    expect(fake.handles[0].closed).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(onSettle).toHaveBeenLastCalledWith('poll');
    expect(onSettle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(fake.watch).toHaveBeenCalledTimes(2);
    const settledSoFar = onSettle.mock.calls.length;
    // Watching again: no more polling.
    vi.advanceTimersByTime(20_000);
    expect(onSettle).toHaveBeenCalledTimes(settledSoFar);
    fake.emit('a.html');
    vi.advanceTimersByTime(300);
    expect(onSettle).toHaveBeenLastCalledWith('change');
    watcher.close();
  });

  it('keeps polling and retrying while watching keeps failing', () => {
    const fake = fakeWatch();
    const onSettle = vi.fn();
    const watcher = createFolderWatcher('/site', onSettle, deps(fake));
    fake.overflow();
    fake.throwOnWatch('EMFILE');
    vi.advanceTimersByTime(10_000);
    expect(fake.watch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10_000);
    expect(fake.watch).toHaveBeenCalledTimes(3);
    expect(onSettle.mock.calls.every(([reason]) => reason === 'poll')).toBe(true);
    expect(onSettle.mock.calls.length).toBeGreaterThanOrEqual(3);
    watcher.close();
  });

  it('polls every 5 seconds on Linux and never watches', () => {
    const fake = fakeWatch();
    const onSettle = vi.fn();
    const watcher = createFolderWatcher('/site', onSettle, deps(fake, 'linux'));
    expect(fake.watch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4999);
    expect(onSettle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSettle).toHaveBeenCalledWith('poll');
    vi.advanceTimersByTime(10_000);
    expect(onSettle).toHaveBeenCalledTimes(3);
    watcher.close();
  });
});

describe('a folder that is missing', () => {
  it('says so once, keeps polling, and notices the folder coming back', () => {
    const fake = fakeWatch();
    fake.throwOnWatch('ENOENT');
    const onSettle = vi.fn();
    const watcher = createFolderWatcher('/site', onSettle, deps(fake));
    vi.advanceTimersByTime(0);
    expect(onSettle.mock.calls).toEqual([['missing']]);
    vi.advanceTimersByTime(25_000);
    expect(onSettle.mock.calls.filter(([reason]) => reason === 'missing')).toHaveLength(1);
    expect(onSettle.mock.calls.filter(([reason]) => reason === 'poll').length).toBeGreaterThan(0);

    fake.throwOnWatch(null);
    onSettle.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(fake.handles).toHaveLength(1);
    expect(onSettle).toHaveBeenCalledWith('change');
    onSettle.mockClear();
    vi.advanceTimersByTime(20_000);
    expect(onSettle).not.toHaveBeenCalled();
    watcher.close();
  });

  it('says so again if it goes missing a second time', () => {
    const fake = fakeWatch();
    fake.throwOnWatch('ENOENT');
    const onSettle = vi.fn();
    const watcher = createFolderWatcher('/site', onSettle, deps(fake));
    vi.advanceTimersByTime(0);
    fake.throwOnWatch(null);
    vi.advanceTimersByTime(10_000);
    fake.throwOnWatch('ENOENT');
    fake.overflow();
    vi.advanceTimersByTime(10_000);
    expect(onSettle.mock.calls.filter(([reason]) => reason === 'missing')).toHaveLength(2);
    watcher.close();
  });
});

describe('close', () => {
  it('stops every timer and the watch', () => {
    const fake = fakeWatch();
    const onSettle = vi.fn();
    const watcher = createFolderWatcher('/site', onSettle, deps(fake));
    fake.emit('a.html');
    watcher.close();
    expect(fake.handles[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    fake.emit('b.html');
    vi.advanceTimersByTime(60_000);
    expect(onSettle).not.toHaveBeenCalled();
  });

  it('stops polling and retrying', () => {
    const fake = fakeWatch();
    const onSettle = vi.fn();
    const watcher = createFolderWatcher('/site', onSettle, deps(fake));
    fake.overflow();
    watcher.close();
    vi.advanceTimersByTime(60_000);
    expect(onSettle).not.toHaveBeenCalled();
    expect(fake.watch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const linux = createFolderWatcher('/site', onSettle, deps(fake, 'linux'));
    linux.close();
    vi.advanceTimersByTime(60_000);
    expect(onSettle).not.toHaveBeenCalled();
  });
});
