import { z } from 'zod';

/** How Runova connects the client to this server once installed. */
export const McpTransportSchema = z.enum(['stdio', 'sse', 'http']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpServerConfigSchema = z.object({
  transport: McpTransportSchema.default('stdio'),
  /** Executable to run for stdio transport (e.g. "npx"). */
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  /** Default env vars bundled with the server; merged under keys in `requiredEnv`. */
  env: z.record(z.string(), z.string()).default({}),
  /** Endpoint for sse/http transport. */
  url: z.string().optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  tags: z.array(z.string()).default([]),
  author: z.string(),
  version: z.string(),
  /** Whether this server is maintained by the vendor/organization it integrates with, vs. a community project. */
  official: z.boolean().default(false),
  popularity: z.number().default(0),
  /** The server's own homepage/docs site, when distinct from its source repository. */
  websiteUrl: z.string().optional(),
  /** Source repository (e.g. GitHub) the server is published from. */
  repositoryUrl: z.string().optional(),
  /** Env var names the user must supply a value for at install time (e.g. API keys). */
  requiredEnv: z.array(z.string()).default([]),
  config: McpServerConfigSchema,
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const McpRepositoryIndexSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  servers: z.array(McpServerSchema),
});
export type McpRepositoryIndex = z.infer<typeof McpRepositoryIndexSchema>;

export type McpRepositorySourceType = 'url' | 'git' | 'local-folder' | 'bundled';

export interface McpRepository {
  id: string;
  name: string;
  sourceType: McpRepositorySourceType;
  source: string;
  addedAt: string;
  lastRefreshedAt: string | null;
}

export function parseMcpRepositoryIndex(raw: unknown): McpRepositoryIndex {
  return McpRepositoryIndexSchema.parse(raw);
}
