import {
  emptyUsageTokens,
  type ProviderUsage,
  type UsageProviderConfig,
  type UsageWindow,
} from '@runova/core';
import { fetchCursorUsage } from './cursor';
import { connectUsage, errorUsage } from './shared';

// Live usage for API-key providers. Each fetcher runs in the main (Node)
// process, so the renderer CSP never applies. These endpoints mostly expose
// credit/spend and quota windows rather than raw token counts (same tradeoff
// CodexBar makes), so cards render cost + a limit bar and leave token counts at
// zero when the provider doesn't report them.

const TIMEOUT_MS = 8000;

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    if (typeof data !== 'object' || data === null) throw new Error('Unexpected response');
    return data as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function costOnlyUsage(
  providerId: string,
  cost30d: number | null,
  window?: UsageWindow,
): ProviderUsage {
  const empty = { tokens: emptyUsageTokens(), costUsd: null };
  return {
    providerId,
    status: 'ok',
    today: empty,
    last7d: empty,
    last30d: { tokens: emptyUsageTokens(), costUsd: cost30d },
    window,
    currency: 'USD',
    updatedAt: new Date().toISOString(),
  };
}

function spendWindow(used: number, total: number | null): UsageWindow | undefined {
  if (total == null || total <= 0) return undefined;
  return {
    label: 'Budget',
    used,
    total,
    percent: Math.max(0, Math.min(100, (used / total) * 100)),
    resetAt: null,
  };
}

// --- Per-provider fetchers --------------------------------------------------

async function fetchOpenRouter(cfg: UsageProviderConfig): Promise<ProviderUsage> {
  const data = await fetchJson('https://openrouter.ai/api/v1/credits', {
    Authorization: `Bearer ${cfg.apiKey}`,
  });
  const d = (data.data ?? {}) as Record<string, unknown>;
  const usage = num(d.total_usage);
  const credits = num(d.total_credits);
  return costOnlyUsage(
    'openrouter',
    usage,
    usage != null && credits != null ? spendWindow(usage, credits) : undefined,
  );
}

async function fetchLiteLLM(cfg: UsageProviderConfig): Promise<ProviderUsage> {
  const base = (cfg.baseUrl || 'http://localhost:4000').replace(/\/$/, '');
  const data = await fetchJson(`${base}/key/info`, { Authorization: `Bearer ${cfg.apiKey}` });
  const info = (data.info ?? data) as Record<string, unknown>;
  const spend = num(info.spend) ?? 0;
  const maxBudget = num(info.max_budget);
  return costOnlyUsage('litellm', spend, spendWindow(spend, maxBudget));
}

async function fetchOpenAI(cfg: UsageProviderConfig): Promise<ProviderUsage> {
  // Admin key required for the organization costs endpoint.
  const start = Math.floor((Date.now() - 30 * 86_400_000) / 1000);
  const data = await fetchJson(
    `https://api.openai.com/v1/organization/costs?start_time=${start}&limit=180`,
    { Authorization: `Bearer ${cfg.apiKey}` },
  );
  const buckets = Array.isArray(data.data) ? (data.data as Record<string, unknown>[]) : [];
  let total = 0;
  for (const bucket of buckets) {
    const results = Array.isArray(bucket.results)
      ? (bucket.results as Record<string, unknown>[])
      : [];
    for (const r of results) {
      const amount = (r.amount ?? {}) as Record<string, unknown>;
      total += num(amount.value) ?? 0;
    }
  }
  return costOnlyUsage('openai', total);
}

async function fetchBalanceWindow(
  providerId: string,
  url: string,
  cfg: UsageProviderConfig,
  pick: (d: Record<string, unknown>) => number | null,
): Promise<ProviderUsage> {
  const data = await fetchJson(url, { Authorization: `Bearer ${cfg.apiKey}` });
  const balance = pick(data);
  if (balance == null) throw new Error('No balance in response');
  // We only know remaining balance, so present it as an informational window.
  return {
    providerId,
    status: 'ok',
    today: { tokens: emptyUsageTokens(), costUsd: null },
    last7d: { tokens: emptyUsageTokens(), costUsd: null },
    last30d: { tokens: emptyUsageTokens(), costUsd: null },
    window: { label: 'Balance', used: 0, total: Math.round(balance), percent: 0, resetAt: null },
    currency: 'USD',
    updatedAt: new Date().toISOString(),
  };
}

async function fetchDeepSeek(cfg: UsageProviderConfig): Promise<ProviderUsage> {
  return fetchBalanceWindow('deepseek', 'https://api.deepseek.com/user/balance', cfg, (d) => {
    const infos = Array.isArray(d.balance_infos)
      ? (d.balance_infos as Record<string, unknown>[])
      : [];
    const total = infos.reduce((sum, i) => sum + (Number(i.total_balance) || 0), 0);
    return infos.length ? total : null;
  });
}

async function fetchMoonshot(cfg: UsageProviderConfig): Promise<ProviderUsage> {
  return fetchBalanceWindow('moonshot', 'https://api.moonshot.ai/v1/users/me/balance', cfg, (d) => {
    const data = (d.data ?? {}) as Record<string, unknown>;
    return num(data.available_balance);
  });
}

async function fetchZai(cfg: UsageProviderConfig): Promise<ProviderUsage> {
  // z.ai's quota endpoint shape isn't publicly stable; treat any structured
  // response as "connected" and surface nothing rather than guessing fields.
  await fetchJson('https://api.z.ai/api/paas/v4/quota', { Authorization: `Bearer ${cfg.apiKey}` });
  return costOnlyUsage('zai', null);
}

const FETCHERS: Record<string, (cfg: UsageProviderConfig) => Promise<ProviderUsage>> = {
  openrouter: fetchOpenRouter,
  litellm: fetchLiteLLM,
  openai: fetchOpenAI,
  deepseek: fetchDeepSeek,
  moonshot: fetchMoonshot,
  zai: fetchZai,
  // Cursor reports per-call token counts, so it fills in real periods and an
  // Auto/API breakdown rather than the cost-only shape above.
  cursor: fetchCursorUsage,
};

/** Fetch usage for an api-key provider, or a connect/error snapshot. */
export async function fetchApiProviderUsage(
  providerId: string,
  cfg: UsageProviderConfig | undefined,
): Promise<ProviderUsage> {
  if (!cfg?.apiKey) return connectUsage(providerId);
  const fetcher = FETCHERS[providerId];
  if (!fetcher) return connectUsage(providerId);
  try {
    return await fetcher(cfg);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Request failed';
    return errorUsage(providerId, message);
  }
}
