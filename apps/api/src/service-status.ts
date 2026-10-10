import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Database } from "@bonded/db";

/**
 * `GET /status` (public, cached): whether the pieces a builder depends on are working, with
 * nothing sensitive in it (counts and ages only, no ids, wallets or URLs). `GET /stats/funnel`
 * (operator token): how many times each onboarding step happened per day, counters only.
 */

/**
 * A lane is healthy when no running job has lost its lease (its worker stopped renewing it), and
 * nothing is waiting or it started (or finished) a job this recently.
 */
export const LANE_STALL_MS = { checks: 10 * 60_000, remote: 30 * 60_000 } as const;

export interface StatusOptions {
  db: Database;
  /** The Arena Gateway's public URL; its /healthz says whether it is up. */
  gatewayUrl?: string;
  /** The deployed version (BONDED_VERSION, or the deploy's commit). */
  version?: string | null;
  cacheMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const ageSeconds = (at: Date | null, nowMs: number) =>
  at ? Math.max(0, Math.round((nowMs - at.getTime()) / 1000)) : null;

export async function serviceStatus(options: StatusOptions) {
  const now = (options.now ?? Date.now)();
  const { db } = options;
  const [checks, remote, gateway] = await Promise.all([
    db.pool.query(
      `SELECT count(*) FILTER (WHERE status='queued')::int AS queued,
         min(created_at) FILTER (WHERE status='queued') AS oldest,
         count(*) FILTER (WHERE status='running')::int AS running,
         min(coalesce(started_at, created_at)) FILTER (WHERE status='running') AS oldest_running,
         count(*) FILTER (WHERE status='running' AND (lease_until IS NULL OR lease_until<now()))::int AS stale,
         max(coalesce(finished_at, started_at)) AS last
       FROM connection_checks WHERE created_at > now() - interval '1 day'`,
    ),
    db.pool.query(
      `SELECT count(*) FILTER (WHERE j.status='queued')::int AS queued,
         count(*) FILTER (WHERE j.status='queued' AND r.preview_id IS NOT NULL)::int AS previews,
         min(r.created_at) FILTER (WHERE j.status='queued') AS oldest,
         count(*) FILTER (WHERE j.status='running')::int AS running,
         min(coalesce((r.progress->>'startedAt')::timestamptz, r.created_at))
           FILTER (WHERE j.status='running') AS oldest_running,
         count(*) FILTER (WHERE j.status='running' AND (j.lease_until IS NULL OR j.lease_until<now()))::int AS stale,
         max((r.progress->>'startedAt')::timestamptz) AS last
       FROM ratings r JOIN jobs j ON j.id=r.id
       WHERE (r.kind='remote' OR r.preview_id IS NOT NULL) AND r.created_at > now() - interval '7 days'`,
    ),
    gatewayUp(options),
  ]);
  const lane = (
    row: {
      queued: number;
      oldest: Date | null;
      running: number;
      oldest_running: Date | null;
      stale: number;
      last: Date | null;
    },
    stallMs: number,
  ) => {
    const last = ageSeconds(row.last, now);
    return {
      healthy: row.stale === 0 && (row.queued === 0 || (last !== null && last * 1000 <= stallMs)),
      queued: row.queued,
      oldestQueuedSeconds: ageSeconds(row.oldest, now),
      running: row.running,
      oldestRunningSeconds: ageSeconds(row.oldest_running, now),
      /** Running jobs whose lease ran out: their worker stopped (or hung) without finishing. */
      staleRunning: row.stale,
      lastJobAgeSeconds: last,
    };
  };
  const checkLane = lane(checks.rows[0], LANE_STALL_MS.checks);
  const remoteLane = lane(remote.rows[0], LANE_STALL_MS.remote);
  return {
    ok: gateway.up !== false && checkLane.healthy && remoteLane.healthy,
    checkedAt: new Date(now).toISOString(),
    version: options.version ?? null,
    api: { up: true },
    gateway,
    lanes: { check: checkLane, remote: remoteLane },
    previewQueue: remote.rows[0].previews as number,
  };
}

async function gatewayUp(
  options: StatusOptions,
): Promise<{ configured: boolean; up: boolean | null }> {
  if (!options.gatewayUrl) return { configured: false, up: null };
  try {
    const r = await (options.fetch ?? fetch)(new URL("/healthz", options.gatewayUrl), {
      signal: AbortSignal.timeout(3_000),
    });
    return { configured: true, up: r.ok };
  } catch {
    return { configured: true, up: false };
  }
}

export function statusRoutes(
  app: Hono,
  options: StatusOptions & { hasToken: (c: Context) => boolean },
) {
  let cache: { at: number; body: Promise<unknown> } | undefined;
  const now = options.now ?? Date.now;
  app.get("/status", async (c) => {
    if (!cache || now() - cache.at >= (options.cacheMs ?? 30_000)) {
      const body = serviceStatus(options);
      body.catch(() => (cache = undefined));
      cache = { at: now(), body };
    }
    c.header("Cache-Control", "public, max-age=30");
    return c.json(await cache.body);
  });
  app.get("/stats/funnel", async (c) => {
    if (!options.hasToken(c)) return c.json({ error: "unauthorized" }, 401);
    const { days } = z
      .strictObject({ days: z.coerce.number().int().min(1).max(90).optional() })
      .parse(c.req.query());
    const rows = await options.db.funnel(days ?? 30, new Date(now()));
    const totals: Record<string, number> = {};
    for (const row of rows)
      for (const [k, v] of Object.entries(row))
        if (k !== "day") totals[k] = (totals[k] ?? 0) + Number(v);
    c.header("Cache-Control", "no-store");
    return c.json({ days: rows, totals, note: "Counts per UTC day; nothing about who." });
  });
}
