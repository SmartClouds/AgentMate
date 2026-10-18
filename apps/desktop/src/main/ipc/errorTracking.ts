import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { z } from 'zod';
import type { ErrorConnectInput, ErrorTokenCheckInput } from '../../shared/errorTrackingTypes';
import { IPC } from '../../shared/ipcChannels';
import { type ErrorTrackingService, getErrorTrackingService } from '../errorTracking/service';
import { broadcastErrorTrackingChanged, errorTrackingSealedKeys } from '../errorTracking/store';
import { onVaultUnlocked, registerSealedSecretStore } from '../ssh/vault';

/**
 * The Errors tab's channels (E24). Every argument is checked here before anything reads it. A
 * token comes in through checkToken, addConnection and replaceToken and is sealed at once; no
 * answer carries it, or its sealed form, back out.
 */

const id = z.string().min(1).max(128);
const slug = z.string().min(1).max(200);
const token = z.string().trim().min(1).max(4096);

const tokenInputSchema = z.object({
  provider: z.literal('sentry'),
  host: z.string().min(1).max(2048),
  token,
});

const connectSchema = tokenInputSchema.extend({
  orgSlug: slug,
  label: z.string().max(200).optional(),
});

const filterSchema = z.object({ projectId: id.optional() }).optional();

const linkSchema = z.object({
  projectId: id,
  connectionId: id,
  remoteProjectId: slug,
  remoteSlug: slug,
  remoteName: z.string().max(200),
});

const querySchema = z.object({
  projectId: id.optional(),
  status: z.enum(['unresolved', 'resolved', 'ignored', 'all']),
  period: z.enum(['24h', '7d', '14d']),
  environment: z.string().max(200).nullable().optional(),
  sort: z.enum(['lastSeen', 'events', 'users', 'newest']),
  search: z.string().max(500).optional(),
  cursor: z.string().max(8192).nullable().optional(),
  refresh: z.boolean().optional(),
});

// Provider issue ids are numbers; anything else would only ever be a path trick.
const refSchema = z.object({
  connectionId: id,
  issueId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
});

const statusSchema = refSchema.extend({
  status: z.enum(['unresolved', 'resolved', 'ignored']),
  ignoreMinutes: z
    .number()
    .int()
    .positive()
    .max(60 * 24 * 365)
    .nullable()
    .optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path.join('.');
  throw new Error(`That error tracking ${what} is not valid${field ? ` (${field})` : ''}.`);
}

export interface ErrorTrackingHandlerOptions {
  /** True for the windows that may use these channels (the main window, in the app). */
  guard?: (event: IpcMainInvokeEvent) => boolean;
  service?: ErrorTrackingService;
}

export function registerErrorTrackingHandlers(options: ErrorTrackingHandlerOptions = {}): void {
  registerSealedSecretStore(errorTrackingSealedKeys);
  const service = options.service ?? getErrorTrackingService();
  // A locked connection can answer now, so the tab reads everything again.
  onVaultUnlocked(() => {
    service.clearCache();
    broadcastErrorTrackingChanged('connections');
  });

  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (options.guard && !options.guard(event)) {
        throw new Error('Error tracking answers only the main window.');
      }
      return listener(...args);
    });
  };

  handle(IPC.errorTracking.checkToken, (value) =>
    service.checkToken(parse(tokenInputSchema, value, 'token check') as ErrorTokenCheckInput),
  );

  handle(IPC.errorTracking.addConnection, (value) =>
    service.addConnection(parse(connectSchema, value, 'connection') as ErrorConnectInput),
  );

  handle(IPC.errorTracking.listConnections, () => service.listConnections());

  handle(IPC.errorTracking.removeConnection, (value) =>
    service.removeConnection(parse(id, value, 'connection id')),
  );

  handle(IPC.errorTracking.replaceToken, (value, tokenValue) =>
    service.replaceToken(parse(id, value, 'connection id'), parse(token, tokenValue, 'token')),
  );

  handle(IPC.errorTracking.remoteProjects, (value) =>
    service.remoteProjects(parse(id, value, 'connection id')),
  );

  handle(IPC.errorTracking.environments, (value) =>
    service.environments(parse(filterSchema, value, 'filter')),
  );

  handle(IPC.errorTracking.listLinks, (value) =>
    service.listLinks(parse(filterSchema, value, 'filter')),
  );

  handle(IPC.errorTracking.setLinks, (projectValue, linksValue) =>
    service.setLinks(
      parse(id, projectValue, 'project id'),
      parse(z.array(linkSchema).max(500), linksValue, 'link'),
    ),
  );

  handle(IPC.errorTracking.listIssues, (value) =>
    service.listIssues(parse(querySchema, value, 'issue filter')),
  );

  handle(IPC.errorTracking.getIssue, (value) => service.getIssue(parse(refSchema, value, 'issue')));

  handle(IPC.errorTracking.setIssueStatus, (value) =>
    service.setIssueStatus(parse(statusSchema, value, 'status change')),
  );

  handle(IPC.errorTracking.fixPrompt, (value) =>
    service.fixPrompt(parse(refSchema, value, 'issue')),
  );
}
