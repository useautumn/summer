import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { AutumnClient } from "../clients/autumn.ts";
import { readAuth } from "../config/storage.ts";
import { log, serializeError } from "../logging/logger.ts";
import { type Filters, queryEvents, queryUsage } from "./aggregate.ts";

/** Parse the `filters` query param (URL-encoded JSON map of key -> string[]). */
function parseFilters(raw: string | undefined): Filters {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Filters = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value) && value.length) out[key] = value.map(String);
    }
    return out;
  } catch {
    return {};
  }
}

const DIST = fileURLToPath(new URL("../../dash/dist", import.meta.url));

export async function serveDash(port: number) {
  const auth = await readAuth();
  if (!auth?.user) {
    throw new Error("Not logged in — run `summer login` first.");
  }
  const client = new AutumnClient(auth);
  const app = new Hono();

  app.get("/api/me", (c) =>
    c.json({ user: auth.user, org: auth.org, appUrl: auth.appUrl })
  );

  app.get("/api/customers", async (c) => {
    try {
      return c.json(
        await client.listCustomers({ limit: 200, search: c.req.query("search") || undefined })
      );
    } catch (error) {
      log.warn({ action: "dash_customers_error", error: serializeError(error) });
      return c.json({ list: [], error: "failed" }, 502);
    }
  });

  app.get("/api/query", async (c) => {
    try {
      const result = await queryUsage(client, {
        customerId: c.req.query("customer_id") || undefined,
        groupBy: c.req.query("group_by") || "none",
        start: Number(c.req.query("start")) || undefined,
        end: Number(c.req.query("end")) || undefined,
        filters: parseFilters(c.req.query("filters"))
      });
      return c.json(result);
    } catch (error) {
      log.warn({ action: "dash_query_error", error: serializeError(error) });
      return c.json({ error: "query failed", rows: [], series: [], facets: {}, total: 0, count: 0 }, 502);
    }
  });

  app.get("/api/events", async (c) => {
    try {
      return c.json(
        await queryEvents(client, {
          customerId: c.req.query("customer_id") || undefined,
          start: Number(c.req.query("start")) || undefined,
          end: Number(c.req.query("end")) || undefined,
          filters: parseFilters(c.req.query("filters")),
          limit: Number(c.req.query("limit")) || 1000
        })
      );
    } catch (error) {
      log.warn({ action: "dash_events_error", error: serializeError(error) });
      return c.json({ list: [], error: "failed" }, 502);
    }
  });

  // Static SPA (dash/dist) with index.html fallback for client-side routing.
  app.get("/*", async (c) => {
    const rel = c.req.path === "/" ? "index.html" : c.req.path.replace(/^\/+/, "");
    let file = Bun.file(join(DIST, rel));
    if (!(await file.exists())) file = Bun.file(join(DIST, "index.html"));
    if (!(await file.exists())) {
      return c.html(
        '<body style="font-family:Inter,system-ui;padding:40px"><h2>Summer dash</h2>' +
          '<p>UI not built yet (run the dash build). The API is live: ' +
          '<a href="/api/query">/api/query</a></p></body>'
      );
    }
    return new Response(file);
  });

  Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 255, fetch: app.fetch });
  log.info({ action: "dash_listening", url: `http://127.0.0.1:${port}` });
}
