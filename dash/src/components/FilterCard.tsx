import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FilterDropdown } from "@/components/FilterDropdown";
import { FILTER_DIMS, type Filters } from "@/lib/api";

export function FilterCard({
  facets,
  filters,
  onChange
}: {
  facets: Record<string, string[]>;
  filters: Filters;
  onChange: (filters: Filters) => void;
}) {
  const activeCount = Object.values(filters).reduce((n, vs) => n + vs.length, 0);

  const setDim = (dim: string, values: string[]) => {
    const updated = { ...filters, [dim]: values };
    if (!values.length) delete updated[dim];
    onChange(updated);
  };

  // Facets haven't arrived yet on first load (the object is empty); show a
  // skeleton rather than the "nothing to filter" message to avoid a flash.
  const loaded = Object.keys(facets).length > 0;
  // Only show dimensions that have more than one option to filter across.
  const dims = FILTER_DIMS.filter((d) => (facets[d.value]?.length ?? 0) > 1);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">Filters</span>
        {activeCount > 0 && (
          <button
            type="button"
            onClick={() => onChange({})}
            className="text-xs text-primary hover:underline"
          >
            Clear ({activeCount})
          </button>
        )}
      </div>
      <Card className="p-3">
        {!loaded ? (
          <div className="grid grid-cols-2 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full rounded-md" />
            ))}
          </div>
        ) : dims.length === 0 ? (
          <p className="text-xs text-tertiary-foreground">No filterable dimensions yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {dims.map((dim) => (
              <FilterDropdown
                key={dim.value}
                label={dim.label}
                options={facets[dim.value]}
                selected={filters[dim.value] ?? []}
                onChange={(values) => setDim(dim.value, values)}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
