// Group-by / filter dimensions. "Main" ones surface as cards; "more" live behind a dropdown.
export const MAIN_GROUPS = [
  { value: "harness", label: "Harness" },
  { value: "model", label: "Model" },
  { value: "user_email", label: "User" }
] as const;

export const MORE_GROUPS = [
  { value: "billing_mode", label: "Billing mode" },
  { value: "source", label: "Source" },
  { value: "session_id", label: "Session" },
  { value: "request_id", label: "Request" },
  { value: "cache_read_tokens", label: "Cache read tokens" },
  { value: "cache_write_tokens", label: "Cache write tokens" }
] as const;

// Dimensions exposed in the Filters card (must be facet keys returned by the server).
export const FILTER_DIMS = [
  { value: "harness", label: "Harness" },
  { value: "model", label: "Model" },
  { value: "billing_mode", label: "Billing mode" },
  { value: "source", label: "Source" }
] as const;

export type Filters = Record<string, string[]>;

export type QueryResult = {
  rows: Array<Record<string, number | string>>;
  series: Array<{ key: string; total: number }>;
  facets: Record<string, string[]>;
  total: number;
  count: number;
  groupBy: string;
  days: number;
};

export type Me = {
  user?: { email?: string | null; id: string };
  org?: { name?: string; env?: string };
  appUrl?: string;
};

export type CustomerMeta = {
  summer?: boolean;
  claude_plan?: string;
  claude_plan_tier?: string;
  claude_5h_pct?: number;
  claude_7d_pct?: number;
  claude_extra_usage_usd?: number;
  claude_extra_usage_enabled?: boolean;
  codex_plan?: string;
  codex_5h_pct?: number;
  codex_7d_pct?: number;
  updated_at?: string;
};

export type Customer = {
  id: string;
  name?: string | null;
  email?: string | null;
  metadata?: CustomerMeta | null;
};

export type UsageEvent = {
  id: string;
  timestamp: number;
  value: number;
  properties: Record<string, unknown>;
};

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

const params = (entries: Record<string, string | number | undefined>, filters?: Filters) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(entries)) if (v != null && v !== "") sp.set(k, String(v));
  const active = filters && Object.values(filters).some((vs) => vs.length);
  if (active) sp.set("filters", JSON.stringify(filters));
  return sp.toString();
};

export type Range = { start: number; end: number };

export const api = {
  me: () => getJSON<Me>("/api/me"),
  customers: (search?: string) =>
    getJSON<{ list: Customer[] }>(`/api/customers?${params({ search })}`),
  query: (p: { groupBy: string; range: Range; customerId?: string; filters?: Filters }) =>
    getJSON<QueryResult>(
      `/api/query?${params(
        { group_by: p.groupBy, start: p.range.start, end: p.range.end, customer_id: p.customerId },
        p.filters
      )}`
    ),
  events: (p: { customerId?: string; range: Range; filters?: Filters; limit?: number }) =>
    getJSON<{ list: UsageEvent[] }>(
      `/api/events?${params(
        { customer_id: p.customerId, start: p.range.start, end: p.range.end, limit: p.limit ?? 1000 },
        p.filters
      )}`
    )
};
