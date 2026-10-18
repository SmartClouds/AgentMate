/**
 * Runs at most `max` calls at once; the rest wait their turn, first come first served. Shared by
 * the remote AI history reader and the SFTP site transport, which both keep a server from being
 * flooded with requests.
 */
export function limiter(max: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (work) => {
    while (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
