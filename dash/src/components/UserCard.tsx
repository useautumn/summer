import { useState } from "react";
import { Gauge } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import type { Customer } from "@/lib/api";
import { cn, usd } from "@/lib/utils";

function Util({ label, pct }: { label: string; pct?: number }) {
  if (pct == null) return null;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-tertiary-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", clamped >= 90 ? "bg-[#e40000]" : "bg-primary")}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function PlanSection({
  title,
  plan,
  fiveHour,
  sevenDay,
  extra
}: {
  title: string;
  plan?: string;
  fiveHour?: number;
  sevenDay?: number;
  extra?: { usd?: number; enabled?: boolean };
}) {
  if (!plan && fiveHour == null && sevenDay == null) return null;
  return (
    <div>
      <div className="mb-2.5 flex items-baseline justify-between border-b border-border pb-2">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-xs text-tertiary-foreground">{plan ?? "—"}</span>
      </div>
      <div className="flex flex-col gap-3">
        <Util label="5-hour limit" pct={fiveHour} />
        <Util label="7-day limit" pct={sevenDay} />
        {extra && (extra.enabled || (extra.usd ?? 0) > 0) && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-tertiary-foreground">Extra usage</span>
            <span className="tabular-nums text-muted-foreground">{usd(extra.usd)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function UserCard({ customer }: { customer?: Customer }) {
  const [open, setOpen] = useState(false);
  if (!customer) return null;
  const m = customer.metadata ?? {};
  const name = customer.email ?? customer.name ?? customer.id;
  const hasLimits =
    m.claude_plan != null ||
    m.codex_plan != null ||
    m.claude_5h_pct != null ||
    m.codex_5h_pct != null;

  return (
    <>
      <Card className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{name}</div>
          {customer.name && customer.email && (
            <div className="truncate text-xs text-tertiary-foreground">{customer.name}</div>
          )}
        </div>
        {hasLimits && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-interactive-secondary px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-interactive-secondary-hover hover:text-foreground"
          >
            <Gauge className="h-3.5 w-3.5" />
            Usage limits
          </button>
        )}
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)} title="Usage limits" description={name}>
        <div className="flex flex-col gap-5">
          <PlanSection
            title="Claude"
            plan={m.claude_plan}
            fiveHour={m.claude_5h_pct}
            sevenDay={m.claude_7d_pct}
            extra={{ usd: m.claude_extra_usage_usd, enabled: m.claude_extra_usage_enabled }}
          />
          <PlanSection
            title="Codex"
            plan={m.codex_plan}
            fiveHour={m.codex_5h_pct}
            sevenDay={m.codex_7d_pct}
          />
        </div>
      </Dialog>
    </>
  );
}
