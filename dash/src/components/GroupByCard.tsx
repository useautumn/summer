import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { MAIN_GROUPS, MORE_GROUPS } from "@/lib/api";
import { cn } from "@/lib/utils";

export function GroupByCard({
  value,
  onChange
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const isMore = MORE_GROUPS.some((g) => g.value === value);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">Group By</span>
        {value !== "none" && (
          <button
            type="button"
            onClick={() => onChange("none")}
            className="text-xs text-primary hover:underline"
          >
            Clear
          </button>
        )}
      </div>
      <Card className="p-2.5">
        <div className="grid grid-cols-2 gap-1.5">
          {MAIN_GROUPS.map((g) => (
            <button
              key={g.value}
              type="button"
              onClick={() => onChange(g.value)}
              className={cn(
                "h-8 rounded-md border px-2.5 text-left text-xs font-medium transition-colors",
                value === g.value
                  ? "border-primary bg-active-primary text-foreground"
                  : "border-border bg-interactive-secondary text-muted-foreground hover:bg-interactive-secondary-hover"
              )}
            >
              {g.label}
            </button>
          ))}
          <Select
            containerClassName="w-full"
            className={cn(
              "h-8 px-2.5 text-left text-xs",
              isMore ? "border-primary text-foreground" : "text-muted-foreground"
            )}
            value={isMore ? value : ""}
            onChange={(e) => e.target.value && onChange(e.target.value)}
          >
            <option value="">Advanced…</option>
            {MORE_GROUPS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </Select>
        </div>
      </Card>
    </div>
  );
}
