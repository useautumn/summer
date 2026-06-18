import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Customer } from "@/lib/api";
import { cn, usd } from "@/lib/utils";

const ROW = 52;

function planOf(c: Customer): string | undefined {
  return c.metadata?.claude_plan ?? c.metadata?.codex_plan ?? undefined;
}

export function UserList({
  customers,
  isLoading,
  search,
  onSearch,
  selectedId,
  onSelect,
  usageByEmail
}: {
  customers: Customer[];
  isLoading: boolean;
  search: string;
  onSearch: (value: string) => void;
  selectedId: string;
  onSelect: (customer: Customer | null) => void;
  usageByEmail: Record<string, number>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: customers.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 12
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary-foreground" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search users…"
          className="h-9 w-full rounded-md border border-border bg-input-background pl-8 pr-8 text-sm text-foreground placeholder:text-tertiary-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-tertiary-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
        {isLoading ? (
          <div>
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 border-b border-border/60 px-3"
                style={{ height: ROW }}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 w-32 rounded-sm" />
                  <Skeleton className="h-2.5 w-20 rounded-sm" />
                </div>
                <Skeleton className="h-3 w-12 rounded-sm" />
              </div>
            ))}
          </div>
        ) : customers.length === 0 ? (
          <div className="p-6 text-center text-sm text-tertiary-foreground">No users found</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const c = customers[item.index];
              const plan = planOf(c);
              const value = usageByEmail[c.email ?? ""] ?? 0;
              const active = c.id === selectedId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelect(active ? null : c)}
                  className={cn(
                    "absolute left-0 top-0 flex w-full items-center gap-3 border-b border-border/60 px-3 text-left transition-colors",
                    active ? "bg-active-primary" : "hover:bg-interactive-secondary"
                  )}
                  style={{ height: ROW, transform: `translateY(${item.start}px)` }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">
                      {c.email ?? c.name ?? c.id}
                    </div>
                    <div className="truncate text-xs text-tertiary-foreground">
                      {plan ?? "No plan"}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                    {usd(value)}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
