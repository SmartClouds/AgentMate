import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/ipcChannels';
import {
  NEWS_CATEGORIES,
  NEWS_SEVERITIES,
  type NewsItemDetailView,
  type NewsListResult,
} from '../../shared/newsTypes';
import { getNewsService } from '../news/runtime';
import type { NewsService } from '../news/service';

/**
 * The news channels (E42). Every payload is checked here before the service reads it. Nothing
 * reaches the network from here except `news:get` and `news:refresh`, and only for the slugs and
 * the one list the contract allows.
 */

const querySchema = z
  .strictObject({
    category: z.array(z.enum(NEWS_CATEGORIES)).max(NEWS_CATEGORIES.length).optional(),
    minSeverity: z.enum(NEWS_SEVERITIES).optional(),
    page: z.number().int().min(1).max(10_000).optional(),
    pageSize: z.number().int().min(1).max(50).optional(),
  })
  .optional();

const slugSchema = z.strictObject({
  slug: z
    .string()
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

const idSchema = z.strictObject({ id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path.join('.');
  throw new Error(`That news ${what} is not valid${field ? ` (${field})` : ''}.`);
}

export interface NewsHandlerOptions {
  /** The service to serve, for tests. The app's own by default. */
  service?: () => NewsService;
}

export function registerNewsHandlers(options: NewsHandlerOptions = {}): void {
  const service = options.service ?? getNewsService;

  ipcMain.handle(
    IPC.news.list,
    (_event, query?: unknown): Promise<NewsListResult> =>
      service().list(parse(querySchema, query, 'filter') ?? {}),
  );

  ipcMain.handle(
    IPC.news.get,
    (_event, payload: unknown): Promise<NewsItemDetailView | null> =>
      service().get(parse(slugSchema, payload, 'item').slug),
  );

  ipcMain.handle(IPC.news.refresh, (): Promise<NewsListResult> => service().refresh());

  ipcMain.handle(
    IPC.news.markRead,
    (_event, payload: unknown): Promise<void> =>
      service().markRead(parse(idSchema, payload, 'item').id),
  );

  ipcMain.handle(
    IPC.news.dismiss,
    (_event, payload: unknown): Promise<void> =>
      service().dismiss(parse(idSchema, payload, 'item').id),
  );
}
