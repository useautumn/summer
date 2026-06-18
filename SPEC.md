# Summer — Specification (v1)

> Summer gives an org honest per-developer visibility into AI-coding **usage and spend** across Claude Code (and later Codex). Local-first; built on Autumn; never charges anyone (no Stripe).

_Shipped + verified end-to-end 2026-06-18._

## Model
- **Developer = one Autumn customer** (local-first: each dev authenticates as themselves).
- `billing_mode` per request, inferred from telemetry: **subscription** (Claude/ChatGPT account session — `user.email`/`organization.id` present) or **api** (API key).
- **Two numbers, both Stripe-free metering:**
  - **`prepaid_spend`** (metered, USD) — money paid: flat seat cost (plan × seats) + credit/balance top-ups. Tag `source` = `seat` | `topup`.
  - **`usage_in_usd`** (AI credit system, USD) — value used: all token consumption, priced by Autumn via Models.dev. Tag `billing_mode` = `subscription` | `api`.
- Rule: real spend = Σ `prepaid_spend`; `usage_in_usd` is the "consumed" lens (never summed in). Utilization = used vs paid.

## Pipeline
Claude Code OTel exporter → local Summer daemon (`/v1/logs`; settings patched by `summer start`) → parse `api_request` → classify subscription/api → `trackTokens(usage_in_usd, properties.billing_mode)` (Autumn prices via Models.dev) → local totals for `summer report`. Re-delivery is a benign no-op (409 duplicate idempotency → skip, no double-count); per-event failures are isolated.

## Cost sources
- **usage_in_usd** — measured from telemetry, priced by Models.dev (markup 0). Real $ for `api`; api-equivalent value for `subscription`.
- **prepaid_spend / seat** — a **declared** flat cost (the plan's price), pushed once per billing cycle (`pushSeatCost`), deduped by local `seatCostPeriod` (YYYY-MM) **and** an Autumn idempotency key `seat:<cust>:<plan>:<month>` (409-tolerant). **No provider billing API is called** — none exists for personal Max; the Anthropic Usage&Cost / OpenAI Costs APIs are a P2 reconciliation for api-key/Console accounts only.
- **prepaid_spend / topup** — manual declaration via `summer credits <usd>` (only when you actually buy credits).

## Plan utilization & extra-usage spend — Claude `/api/oauth/usage`
The daemon polls `GET https://api.anthropic.com/api/oauth/usage` (Keychain OAuth token; headers `anthropic-beta: oauth-2025-04-20` + `User-Agent: claude-code/<v>`) sparsely (≥180s; default 300s). It yields plan **utilization** (`five_hour`/`seven_day`/`limits[]` — percent, severity, resets) and a `spend`/`extra_usage` block where `spend.used.amount_minor` ÷ 10^exponent = **USD overage/credit spend**.
- Utilization → cached in `state.oauthUsage`, shown in `summer report` + `summer usage`.
- Extra-usage spend → pushed into `prepaid_spend` as **deltas** (the value is cumulative), `source=anthropic_extra_usage`, idempotency `extra:<cust>:<month>:<used_minor>` — counted once, never double-counted with the flat seat.
- Caveats: undocumented + aggressively rate-limited; dollar figures appear only when "extra usage" is enabled. For guaranteed-stable official $ on the API/Console path, the Cost Report API remains the robust option.

## Autumn
- `summer setup` creates two features: `prepaid_spend` (metered) + `usage_in_usd` (ai_credit_system).
- No products/plans attached → no Stripe. Plan tier stored in local state. `usage_in_usd` has no granted balance — it's an analytics bucket (`trackTokens` records the value even with `balance:null`).
- OAuth scopes: organisation/customers/balances/features + **analytics:read** (needed for `events.list` / `events.aggregate`). A re-login is required to pick up a newly added scope.

## CLI
`start`, `stop`, `status`, `setup`, `plan [planId]`, `credits <usd>`, `report`, `refresh-auth`.

## Verification (done)
- `bun run ts` + `bun test` green.
- Live `claude -p` → daemon → `usage_in_usd` (billing_mode=subscription), confirmed via local totals + `trackTokens` 200; customer exists in Autumn (`GET /v1/customers/<id>` → 200).
- Re-delivery doesn't double-count.

## Out of scope (v1)
Per-request included-vs-credits; provider billing-API reconciliation (P2); Codex (P3 — parser ready, same trackTokens path); product-attach with `no_billing_changes` (P1.5); Bedrock/Vertex; web UI; charging anyone.
