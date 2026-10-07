import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { Database, json, AgentNotConfiguredError, PAGE_LIMIT } from "@bonded/db";
import {
  QuoteError,
  SELF_SERVE_MAX_COVER_USD,
  bondedRegistryAbi,
  bountyBoardAbi,
  leaderboardHeadline,
} from "@bonded/shared";
import { readLeaderboard, BountySpecError, parseBountySpec, specUri } from "@bonded/arena";
import type { ServiceChain } from "@bonded/keeper";
import type { Hex } from "viem";
import { issueQuote } from "./quotes.js";
import { EventStreams } from "./events.js";
import { teeQuoteBlock } from "./tee-watch.js";
import { RateLimiter, clientAddress } from "./rate-limit.js";
import { selfServeRoutes, type SelfServeLimits } from "./self-serve.js";
import { libraryRoutes, MAX_BODY_BYTES } from "./library.js";
export { issueQuote } from "./quotes.js";
/** A decimal id, in canonical form: "01" and "1" are the same agent, so they must be the same key. */
const uint = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform((v) => BigInt(v).toString());
/** Query parameters shared by the paginated lists: a cursor from the previous page and a size. */
const pageQuery = {
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT.max).optional(),
};
const episodesQuery = z.strictObject({
  ...pageQuery,
  // An event id (bigint) from the previous page's `next`.
  before: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
  runId: z.uuid().optional(),
  outcome: z.enum(["held", "breach", "control"]).optional(),
  class: z
    .string()
    .regex(/^A\d{1,2}$/)
    .optional(),
});
const bountiesQuery = z.strictObject({ ...pageQuery, before: uint.optional() });
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
  /** The published leaderboard (default: config/leaderboard.json). */
  leaderboardFile?: string;
  /** Limits on the public bounty reveal (default: 10 per client and 120 in all per 10 minutes). */
  revealLimit?: ConstructorParameters<typeof RateLimiter>[0];
  /** How long a leaderboard response is reused before the chain is read again. */
  leaderboardCacheMs?: number;
  /** How long GET /episodes reuses its outcome counts (default 10 seconds). */
  episodeCountsCacheMs?: number;
  /** Limits on self-serve ratings and quotes without the operator token (see self-serve.ts). */
  selfServe?: Partial<SelfServeLimits>;
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
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "the request body is over 16 KB" }, 413),
    }),
  );
  // POSTs that need no operator token: a bounty reveal (the hash check against the chain's
  // revealed specURI authenticates it), self-serve requests (signed by the agent's owner) and
  // quotes (capped without the token; buyCover checks the guardian on chain).
  const PUBLIC_POST = /^\/(bounties\/\d{1,78}\/reveal|self\/agents(\/\d{1,78}\/rate)?|quotes)$/;
  const hasToken = (header: string | undefined) => {
    const token = Buffer.from(header ?? "");
    const expected = Buffer.from(`Bearer ${options.apiToken}`);
    return token.length === expected.length && timingSafeEqual(token, expected);
  };
  app.use("*", async (c, next) => {
    if (
      c.req.method === "POST" &&
      !PUBLIC_POST.test(c.req.path) &&
      !hasToken(c.req.header("Authorization"))
    )
      return c.json({ error: "unauthorized" }, 401);
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
  // Without the operator token, a quote is capped (testnet) and rate-limited, so one user can't
  // take the pool's whole capacity or flood the signer.
  const quoteLimit = new RateLimiter({ perClient: 20, total: 300, windowMs: 10 * 60_000 });
  app.post("/quotes", async (c) => {
    const input = quoteInput.parse(await c.req.json());
    if (!hasToken(c.req.header("Authorization"))) {
      if (!quoteLimit.allow(clientAddress(c.req.raw.headers)))
        return c.json({ error: "too many quote requests; try again in a few minutes" }, 429);
      if (BigInt(input.coverAmount) > BigInt(SELF_SERVE_MAX_COVER_USD) * 1_000_000n)
        return c.json(
          {
            error: `cover is capped at ${SELF_SERVE_MAX_COVER_USD.toLocaleString("en-US")} tUSDG on testnet`,
          },
          400,
        );
    }
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
  // Class-level results only (docs/disclosures). Each entry posted on this API's chain is checked
  // against the registry: `verified` means its current score has the same report hash.
  // Each response reads the registry once per entry, so it is reused for a minute: a public page
  // must not turn every visit into RPC calls.
  const leaderboardCacheMs = options.leaderboardCacheMs ?? 60_000;
  let leaderboardCache: { at: number; body: unknown } | undefined;
  app.get("/leaderboard", async (c) => {
    if (leaderboardCache && Date.now() - leaderboardCache.at < leaderboardCacheMs)
      return c.json(leaderboardCache.body);
    const entries = readLeaderboard(options.leaderboardFile);
    const checked = await Promise.all(
      entries.map(async (e) => {
        if (
          !e.onchain?.tx ||
          e.onchain.chain !== "robinhoodTestnet" ||
          chain.deployment.chainId !== 46630
        )
          return { ...e, verified: null };
        const s = await chain.read
          .readContract({
            address: chain.deployment.registry,
            abi: bondedRegistryAbi,
            functionName: "scoreOf",
            args: [BigInt(e.onchain.agentId)],
          })
          .catch(() => undefined);
        return {
          ...e,
          verified: s
            ? s.reportHash.toLowerCase() === e.reportHash.toLowerCase() && s.score === e.score
            : null,
        };
      }),
    );
    const body = { headline: leaderboardHeadline(entries), entries: checked };
    leaderboardCache = { at: Date.now(), body };
    return c.json(body);
  });
  // BountyBoard.Status: None, Committed, Revealed, Accepted, Rejected.
  const REVEALED = 2;
  const revealLimit = new RateLimiter(
    options.revealLimit ?? { perClient: 10, total: 120, windowMs: 10 * 60_000 },
  );
  app.post("/bounties/:id/reveal", async (c) => {
    if (!revealLimit.allow(clientAddress(c.req.raw.headers)))
      return c.json({ error: "too many reveal requests; try again in a few minutes" }, 429);
    const id = uint.parse(c.req.param("id"));
    const yaml = await c.req.text();
    const submission = await chain.read
      .readContract({
        address: chain.deployment.bountyBoard,
        abi: bountyBoardAbi,
        functionName: "getSubmission",
        args: [BigInt(id)],
      })
      .catch(() => undefined);
    if (!submission) return c.json({ error: "no such submission" }, 404);
    if (submission.status < REVEALED)
      return c.json({ error: "reveal the submission on BountyBoard first" }, 409);
    if (submission.specURI !== specUri(yaml))
      return c.json({ error: "the spec's sha256 doesn't match the revealed specURI" }, 400);
    // A repeated post, even after settlement, returns the submission's status.
    const known = await db.bountyStatus(chain.deployment.chainId, id);
    if (known) return c.json({ created: false, status: known }, 200);
    if (submission.status !== REVEALED)
      return c.json({ error: "the submission was settled on chain without validation here" }, 409);
    let spec;
    try {
      spec = parseBountySpec(yaml);
    } catch (e) {
      if (e instanceof BountySpecError) return c.json({ error: e.message }, 400);
      throw e;
    }
    const result = await db.submitBounty({
      chainId: chain.deployment.chainId,
      submissionId: id,
      hunter: submission.hunter,
      specUri: submission.specURI,
      specYaml: yaml,
      spec,
    });
    return c.json(result, result.created ? 202 : 200);
  });
  app.get("/bounties", async (c) => {
    const q = bountiesQuery.parse(c.req.query());
    return c.json(await db.bounties(chain.deployment.chainId, q));
  });
  // The first page also carries outcome counts and `through`, the event id they were counted
  // up to: a live stream opened after `through` adds exactly the episodes the counts don't have
  // (the web drops the ones it already has from the pages). Counting scans a run's, or the
  // retention window's, episodes, so a count is reused briefly: the Arena page must not turn
  // every visit into a full count. A reused count is still exact up to its own `through`.
  const countsCacheMs = options.episodeCountsCacheMs ?? 10_000;
  const countsCache = new Map<string, { at: number; through: string; counts: unknown }>();
  app.get("/episodes", async (c) => {
    const { class: attackClass, ...q } = episodesQuery.parse(c.req.query());
    const filters = { ...q, ...(attackClass ? { attackClass } : {}) };
    if (q.before !== undefined) return c.json(await db.episodes(filters));
    const key = q.runId ?? "all";
    let cached = countsCache.get(key);
    if (!cached || Date.now() - cached.at >= countsCacheMs) {
      const through = await db.latestEventId();
      cached = { at: Date.now(), through, counts: await db.episodeCounts(through, q.runId) };
      if (countsCache.size > 500) countsCache.clear();
      countsCache.set(key, cached);
    }
    const page = await db.episodes(filters);
    return c.json({ ...page, counts: cached.counts, through: cached.through });
  });
  selfServeRoutes(app, { db, chain, ...(options.selfServe ? { limits: options.selfServe } : {}) });
  libraryRoutes(app, { db, chainId: chain.deployment.chainId });
  app.get("/events", async (c) => {
    const after = uint.parse(c.req.header("Last-Event-ID") ?? c.req.query("after") ?? "0");
    const runId = c.req.query("runId");
    if (runId) z.uuid().parse(runId);
    return events.open(c, after, runId);
  });
  return Object.assign(app, { close: () => events.close() });
}
