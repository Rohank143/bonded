import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { Database, json, AgentNotConfiguredError } from "@bonded/db";
import { QuoteError } from "@bonded/shared";
import type { ServiceChain } from "@bonded/keeper";
import type { Hex } from "viem";
import { issueQuote } from "./quotes.js";
import { EventStreams } from "./events.js";
import { teeQuoteBlock } from "./tee-watch.js";
export { issueQuote } from "./quotes.js";
/** A decimal id, in canonical form: "01" and "1" are the same agent, so they must be the same key. */
const uint = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform((v) => BigInt(v).toString());
const quoteInput = z.strictObject({
  agentId: uint,
  vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  coverAmount: uint.refine((v) => BigInt(v) > 0n),
});

/** Build the HTTP API; call close() to drain its SSE listeners before closing Postgres. */
export function createApi(options: {
  db: Database;
  chain: ServiceChain;
  attesterKey: Hex;
  apiToken: string;
  /** Browser origins allowed to call the API, e.g. the web app's URL. Empty allows none. */
  webOrigins?: readonly string[];
}) {
  const { db, chain } = options;
  if (options.apiToken.length < 24)
    throw new Error("API_TOKEN must contain at least 24 characters");
  const app = new Hono();
  const events = new EventStreams(db);
  // Before the token check, so a browser can read a 401 and preflight requests succeed.
  const origins = new Set(options.webOrigins ?? []);
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.has(origin) ? origin : null),
      allowMethods: ["GET", "POST"],
      allowHeaders: ["Content-Type", "Authorization", "Last-Event-ID"],
      maxAge: 600,
    }),
  );
  app.use("*", bodyLimit({ maxSize: 16384 }));
  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      const token = Buffer.from(c.req.header("Authorization") ?? "");
      const expected = Buffer.from(`Bearer ${options.apiToken}`);
      if (token.length !== expected.length || !timingSafeEqual(token, expected))
        return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  app.onError((e, c) => {
    if (e instanceof z.ZodError || e instanceof SyntaxError)
      return c.json({ error: "invalid request" }, 400);
    if (e instanceof AgentNotConfiguredError) return c.json({ error: "agent not configured" }, 404);
    if (e instanceof QuoteError) return c.json({ error: e.message }, 409);
    console.error("API request failed", e.name);
    return c.json({ error: "request failed" }, 503);
  });
  app.get("/health", async (c) => {
    await db.pool.query("SELECT 1");
    return c.json({ ok: true, chainId: chain.deployment.chainId });
  });
  app.get("/agents/:id/score", async (c) => {
    const id = uint.parse(c.req.param("id"));
    const r = await db.pool.query(
      'SELECT id AS "runId",signed,tx_hash FROM attestations WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 1',
      [`${chain.deployment.chainId}:${id}`],
    );
    return r.rowCount ? c.json(r.rows[0]) : c.json({ error: "score not found" }, 404);
  });
  app.get("/agents/:id/tee", async (c) => {
    const id = uint.parse(c.req.param("id"));
    const check = await db.teeCheck(`${chain.deployment.chainId}:${id}`);
    return check ? c.json(check) : c.json({ error: "no TEE check for this agent" }, 404);
  });
  app.post("/quotes", async (c) => {
    const input = quoteInput.parse(await c.req.json());
    // New cover for an agent with TEE custody needs the vault's key to be the TEE's key and no
    // outstanding failure (ADR-013, ADR-014). Decided against the same block the quote is built at.
    const teeRow = await db.teeCheck(`${chain.deployment.chainId}:${input.agentId}`);
    const signed = await issueQuote(
      chain,
      { ...input, vault: input.vault as Hex },
      options.attesterKey,
      ({ teeMeasurement, reportHash, vaultAgent }) =>
        teeQuoteBlock({
          onchainMeasurement: teeMeasurement,
          onchainReportHash: reportHash,
          vaultAgent,
          row: teeRow,
        }),
    );
    await db.pool.query("INSERT INTO quotes(id,chain_id,agent_id,signed) VALUES($1,$2,$3,$4)", [
      randomUUID(),
      chain.deployment.chainId,
      input.agentId,
      json(signed),
    ]);
    return c.json(signed, 201);
  });
  app.post("/arena/runs", async (c) => {
    const { agentId } = z.strictObject({ agentId: uint }).parse(await c.req.json());
    const id = `${chain.deployment.chainId}:${agentId}`;
    return c.json({ runId: await db.enqueue(id) }, 202);
  });
  for (const path of ["/arena/runs/:id", "/arena/runs/:id/report"])
    app.get(path, async (c) => {
      const id = z.uuid().parse(c.req.param("id"));
      const r = await db.pool.query(
        "SELECT id,status,report,report_json,error,created_at FROM ratings WHERE id=$1",
        [id],
      );
      if (!r.rowCount) return c.json({ error: "run not found" }, 404);
      const row = r.rows[0];
      if (path.endsWith("/report"))
        return row.report_json
          ? c.body(row.report_json, 200, { "Content-Type": "application/json; charset=utf-8" })
          : c.json(
              {
                status: row.status,
                error: row.report ? "original report bytes unavailable" : undefined,
              },
              202,
            );
      return c.json(row);
    });
  app.get("/events", async (c) => {
    const after = uint.parse(c.req.header("Last-Event-ID") ?? c.req.query("after") ?? "0");
    const runId = c.req.query("runId");
    if (runId) z.uuid().parse(runId);
    return events.open(c, after, runId);
  });
  return Object.assign(app, { close: () => events.close() });
}
