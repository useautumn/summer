import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn, label as fmt } from "@/lib/utils";

/** A searchable multi-select dropdown for one filter dimension. */
export function FilterDropdown({
  label,
  options,
  selected,
  onChange
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const query = q.toLowerCase();
  const filtered = options.filter(
    (o) => o.toLowerCase().includes(query) || fmt(o).toLowerCase().includes(query)
  );
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-2 rounded-md border px-2.5 text-xs transition-colors",
          selected.length
            ? "border-primary/60 bg-active-primary text-foreground"
            : "border-border bg-interactive-secondary text-muted-foreground hover:bg-interactive-secondary-hover"
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {label}
          {selected.length > 0 && (
            <span className="rounded bg-primary/20 px-1 text-[10px] font-medium text-primary">
              {selected.length}
            </span>
          )}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-tertiary-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-[230px] max-w-[80vw] rounded-lg border border-border bg-popover p-1 shadow-xl">
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary-foreground" />
            <input
              // biome-ignore lint/a11y/noAutofocus: focus the search when the dropdown opens
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="h-8 w-full rounded-md border border-border bg-input-background pl-7 pr-2 text-xs text-foreground placeholder:text-tertiary-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>
          <div className="max-h-56 overflow-auto">
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-xs text-tertiary-foreground">No matches</div>
            ) : (
              filtered.map((v) => {
                const on = selected.includes(v);
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => toggle(v)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-interactive-secondary"
                  >
                    <span
                      className={cn(
                        "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-border"
                      )}
                    >
                      {on && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                    </span>
                    <span className="truncate text-foreground">{fmt(v)}</span>
                  </button>
                );
              })
            )}
          </div>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-primary hover:bg-interactive-secondary"
            >
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
