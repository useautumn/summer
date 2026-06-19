import { useState, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Database } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { UsageEvent } from "@/lib/api";
import { cn, dateTime, label, relativeTime, usd } from "@/lib/utils";

const ROW = 36;

function EventDialog({ event, onClose }: { event: UsageEvent | null; onClose: () => void }) {
  const rows: Array<[string, string]> = event
    ? [
        ["Time", new Date(event.timestamp).toLocaleString()],
        ["Value", usd(event.value)],
        ...Object.entries(event.properties ?? {})
          .filter(([, v]) => v != null && v !== "")
          .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)] as [string, string])
      ]
    : [];

  return (
    <Dialog open={!!event} onClose={onClose} title="Event" description={event ? relativeTime(event.timestamp) : ""}>
      <div className="-mr-5 max-h-[60vh] overflow-auto pr-5">
        {rows.map(([k, v]) => (
          <div
            key={k}
            className="flex items-start justify-between gap-4 border-b border-border/60 py-2 text-xs last:border-0"
          >
            <span className="shrink-0 text-tertiary-foreground">{k}</span>
            <span className="break-all text-right font-mono text-foreground">{v}</span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

const COLUMNS = [
  { key: "time", label: "Time", className: "w-40" },
  { key: "user", label: "User", className: "flex-1 min-w-0" },
  { key: "harness", label: "Harness", className: "w-28" },
  { key: "model", label: "Model", className: "flex-1 min-w-0" },
  { key: "mode", label: "Mode", className: "w-28" },
  { key: "value", label: "Value", className: "w-24 text-right" }
] as const;

function cellValue(e: UsageEvent, key: string): string {
  const p = e.properties ?? {};
  if (key === "time") return dateTime(e.timestamp);
  if (key === "value") return usd(e.value);
  if (key === "user") return p.user_email ? String(p.user_email) : "—";
  return label(String(p[key === "mode" ? "billing_mode" : key] ?? "")) || "—";
}

export function EventsTable({
  events,
  isLoading,
  count
}: {
  events: UsageEvent[];
  isLoading: boolean;
  count: number;
}) {
  const [selected, setSelected] = useState<UsageEvent | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 16
  });

  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CardHeader className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-tertiary-foreground" />
          Events
        </span>
        <span className="text-xs font-normal text-tertiary-foreground">
          {isLoading ? "—" : `${count.toLocaleString()} events`}
        </span>
      </CardHeader>

      {/* Column header lives INSIDE the scroll container so it shares the row
          width (minus the scrollbar) and stays perfectly aligned. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="sticky top-0 z-10 flex h-8 items-center border-b border-border bg-card px-4 text-xs font-medium text-tertiary-foreground">
          {COLUMNS.map((col) => (
            <div key={col.key} className={col.className}>
              {col.label}
            </div>
          ))}
        </div>
        {isLoading ? (
          <div className="flex flex-col gap-1.5 p-2">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-tertiary-foreground">
            <Database className="h-7 w-7 opacity-40" />
            <p className="text-sm">No events to display.</p>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const e = events[item.index];
              return (
                <div
                  key={e.id}
                  onClick={() => setSelected(e)}
                  className="absolute left-0 top-0 flex w-full cursor-pointer items-center border-b border-border/40 px-4 text-sm hover:bg-interactive-secondary"
                  style={{ height: ROW, transform: `translateY(${item.start}px)` }}
                >
                  {COLUMNS.map((col) => (
                    <div
                      key={col.key}
                      className={cn(
                        col.className,
                        "truncate tabular-nums",
                        col.key === "time" || col.key === "model"
                          ? "text-tertiary-foreground"
                          : "text-muted-foreground",
                        col.key === "value" && "text-foreground"
                      )}
                    >
                      {cellValue(e, col.key)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <EventDialog event={selected} onClose={() => setSelected(null)} />
    </Card>
  );
}
