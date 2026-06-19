export function numberAttr(attrs: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function stringAttr(attrs: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function flattenOtelAttributes(attributes: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(attributes)) return out;
  for (const attr of attributes) {
    if (!attr || typeof attr !== "object") continue;
    const key = (attr as { key?: unknown }).key;
    const value = (attr as { value?: Record<string, unknown> }).value;
    if (typeof key !== "string" || !value) continue;
    out[key] =
      value.stringValue ??
      value.string_value ??
      value.intValue ??
      value.int_value ??
      value.doubleValue ??
      value.double_value ??
      value.boolValue ??
      value.bool_value ??
      value.arrayValue ??
      value.array_value ??
      value.kvlistValue ??
      value.kvlist_value;
  }
  return out;
}

export function visitLogRecords(payload: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const source = payload as { resourceLogs?: unknown[]; resource_logs?: unknown[] };
  const resourceLogs = source.resourceLogs ?? source.resource_logs ?? [];
  for (const resourceLog of resourceLogs) {
    const resource = resourceLog as {
      resource?: { attributes?: unknown };
      scopeLogs?: unknown[];
      scope_logs?: unknown[];
    };
    const resourceAttrs = flattenOtelAttributes(resource.resource?.attributes);
    const scopeLogs = resource.scopeLogs ?? resource.scope_logs ?? [];
    for (const scopeLog of scopeLogs) {
      const scope = scopeLog as { logRecords?: unknown[]; log_records?: unknown[] };
      const logRecords = scope.logRecords ?? scope.log_records ?? [];
      for (const logRecord of logRecords) {
        if (!logRecord || typeof logRecord !== "object") continue;
        records.push({
          ...resourceAttrs,
          ...(logRecord as Record<string, unknown>)
        });
      }
    }
  }
  return records;
}

/** The log record's event time in epoch ms, from OTLP `timeUnixNano` (ns). Undefined if absent. */
export function otelTimestampMs(attrs: Record<string, unknown>): number | undefined {
  const ns = numberAttr(
    attrs,
    "timeUnixNano",
    "time_unix_nano",
    "observedTimeUnixNano",
    "observed_time_unix_nano"
  );
  if (ns == null || ns <= 0) return undefined;
  return Math.round(ns / 1e6);
}

export function logRecordAttributes(record: Record<string, unknown>) {
  return {
    ...record,
    ...flattenOtelAttributes(record.attributes)
  };
}
