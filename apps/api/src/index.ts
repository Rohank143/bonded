import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  Database,
  json,
  AgentNotConfiguredError,
  PAGE_LIMIT,
  type EpisodeCounts,
  type EpisodeFilters,
} from "@bonded/db";
import {
  QuoteError,
  REMOTE_KIND,
  SELF_SERVE_MAX_COVER_USD,
  UNDERWRITING_COVER_CAP_USD,
  bondedRegistryAbi,
  bountyBoardAbi,
  leaderboardHeadline,
  type BindingLevel,
} from "@bonded/shared";
import {
  AgentUrlClient,
  readLeaderboard,
  BountySpecError,
  loadAttackLibrary,
  parseBountySpec,
  specUri,
} from "@bonded/arena";
import type { ServiceChain } from "@bonded/keeper";
import type { Hex } from "viem";
import { issueQuote } from "./quotes.js";
import { originAllowed } from "./origins.js";
import {
  SENTINEL_CHECK_MAX_BYTES,
  sentinelRoutes,
  type SentinelLimits,
  type SentinelService,
} from "./sentinel.js";
import { EventStreams } from "./events.js";
import { teeQuoteBlock } from "./tee-watch.js";
import { RateLimiter, clientAddress } from "./rate-limit.js";
import { selfServeRoutes, type SelfServeLimits } from "./self-serve.js";
import { libraryRoutes, MAX_BODY_BYTES } from "./library.js";
import { observedRatesRoute } from "./observed-rates.js";
import { ratingFacts } from "./rating-facts.js";
import { sessionRoutes } from "./sessions.js";
import { ownDomainsFrom, ownerRoutes } from "./previews.js";
import { notificationRoutes, type EmailSender } from "./notifications.js";
import { PollStreams } from "./poll-stream.js";
import { DEFAULT_REMOTE_POLICY } from "./remote-policy.js";
import type { SecretBox } from "./secrets.js";
import { gatewayUrlVerifier, type AgentUrlVerifier } from "./connections.js";
export { issueQuote } from "./quotes.js";
/** A decimal id, in canonical form: "01" and "1" are the same agent, so they must be the same key. */
const uint = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform((v) => BigInt(v).toString());
/** Query parameters shared by the numbered lists: a 1-based page and a page size. */
const pageQuery = {
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT.max).optional(),
};
const attackClass = z.string().regex(/^A\d{1,2}$/);
const episodesQuery = z.strictObject({
  ...pageQuery,
  // The snapshot: the event id the first page returned. Pages read only events up to it.
  through: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
  runId: z.uuid().optional(),
  agentId: uint.optional(),
  outcome: z.enum(["held", "breach", "control"]).optional(),
  class: attackClass.optional(),
  // One attack's episodes, by its id.
  attack: z
    .string()
    .regex(/^A(10|[1-9])-[a-z0-9-]{1,120}$/)
    .optional(),
  source: z.enum(["held-out", "library"]).optional(),
  since: z.enum(["1h", "24h", "7d"]).optional(),
});
const bountiesQuery = z.strictObject({
  ...pageQuery,
  status: z.enum(["validating", "accepted", "rejected", "failed"]).optional(),
  class: attackClass.optional(),
  hunter: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  submission: uint.optional(),
  sort: z.enum(["newest", "reward"]).optional(),
});
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
  /** How long GET /episodes reuses a snapshot's counts (default a minute). */
  episodeCountsCacheMs?: number;
  /** Limits on self-serve ratings and quotes without the operator token (see self-serve.ts). */
  selfServe?: Partial<SelfServeLimits>;
  /** The Sentinel guard, for `POST /sentinel/check` (see sentinel.ts). Without it, checks are refused. */
  sentinel?: SentinelService;
  /** Limits on Sentinel checks (see sentinel.ts). */
  sentinelLimits?: Partial<SentinelLimits>;
  /** The Arena Gateway's public URL, shown to owners in the runner command. */
  gatewayUrl?: string;
  /**
   * Underwriting policy: total cover caps, in tUSDG, for agents their operators run, by binding
   * (default `UNDERWRITING_COVER_CAP_USD`: 5,000 declared, 20,000 TEE).
   */
  coverCaps?: Readonly<Record<BindingLevel, number>>;
  /**
   * Encrypts Agent URL and webhook secrets (AGENT_URL_SECRET_KEY). Without it, Agent URL mode and
   * webhooks are refused.
   */
  secrets?: SecretBox;
  /** Answers an Agent URL's verify challenge (default: the Arena Gateway's). */
  verifyAgentUrl?: AgentUrlVerifier;
  /** Sends notification emails, when configured (RESEND_API_KEY and EMAIL_FROM). */
  email?: EmailSender;
  /** Bonded's own hosts, which an Agent URL or webhook may not use (beyond the web origins). */
  ownDomains?: readonly string[];
  /** Agent URLs and webhooks may be plain http on this machine: local demos and tests only. */
  allowLoopbackUrls?: boolean;
  /** Requests per client to the preview, check and notification routes, per window. */
  ownerRequests?: {
    writes?: ConstructorParameters<typeof RateLimiter>[0];
    reads?: ConstructorParameters<typeof RateLimiter>[0];
    /** Connection checks per client address per hour (default 30). */
    checksPerClientHourly?: number;
  };
}) {
  const { db, chain } = options;
  if (options.apiToken.length < 24)
    throw new Error("API_TOKEN must contain at least 24 characters");
  const app = new Hono();
  const events = new EventStreams(db);
  // Before the token check, so a browser can read a 401 and preflight requests succeed.
  const origins = options.webOrigins ?? [];
  app.use(
    "*",
    cors({
      origin: (origin) => (originAllowed(origin, origins) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "DELETE"],
      allowHeaders: ["Content-Type", "Authorization", "Last-Event-ID"],
      maxAge: 600,
    }),
  );
  const smallBodies = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "the request body is over 16 KB" }, 413),
  });
  // A Sentinel check carries what the agent read (up to 20 reads of 4,000 characters), so its
  // route has its own, larger cap: the most its schema allows (sentinel.ts).
  const checkBodies = bodyLimit({
    maxSize: SENTINEL_CHECK_MAX_BYTES,
    onError: (c) => c.json({ error: "the check is over 256 KB" }, 413),
  });
  app.use("*", (c, next) =>
    c.req.path === "/sentinel/check" ? checkBodies(c, next) : smallBodies(c, next),
  );
  // POSTs that need no operator token: a bounty reveal (the hash check against the chain's
  // revealed specURI authenticates it), self-serve requests (signed by the agent's owner: register,
  // rate, and create or revoke a runner token) and quotes (capped without the token; buyCover
  // checks the guardian on chain) and Sentinel checks (signed by the agent's own key, see
  // sentinel.ts). Every other POST or DELETE needs the operator token.
  // Previews, Agent URLs, checks and notification settings are made with an owner session
  // (sessions.ts), opened by a wallet signature.
  const PUBLIC_POST =
    /^\/(bounties\/\d{1,78}\/reveal|self\/agents(\/\d{1,78}\/(rate|runner-token|agent-url|agent-url\/verify|checks))?|quotes|sentinel\/check|self\/session|self\/notifications(\/webhook-secret)?|previews(\/session|\/[0-9a-f-]{36}\/(stop|runner-token|agent-url|agent-url\/verify|checks|rate|notifications))?|self\/agents\/\d{1,78}\/notifications|streams\/ticket)$/;
  const PUBLIC_PUT =
    /^\/(self\/notifications|previews\/[0-9a-f-]{36}\/notifications|self\/agents\/\d{1,78}\/notifications)$/;
  const PUBLIC_DELETE =
    /^\/(self\/agents\/\d{1,78}\/(runner-token|agent-url)|self\/session|previews\/session|previews\/[0-9a-f-]{36}\/(runner-token|agent-url))$/;
  const hasToken = (header: string | undefined) => {
    const token = Buffer.from(header ?? "");
    const expected = Buffer.from(`Bearer ${options.apiToken}`);
    return token.length === expected.length && timingSafeEqual(token, expected);
  };
  app.use("*", async (c, next) => {
    const open =
      c.req.method === "POST"
        ? PUBLIC_POST.test(c.req.path)
        : c.req.method === "DELETE"
          ? PUBLIC_DELETE.test(c.req.path)
          : c.req.method === "PUT"
            ? PUBLIC_PUT.test(c.req.path)
            : true;
    if (!open && !hasToken(c.req.header("Authorization")))
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
  // Bring your own agent, round 2: sessions, previews, Agent URLs, checks, estimates, progress
  // and notification settings.
  const ownerNow = options.selfServe?.now ?? Date.now;
  const writes = new RateLimiter({
    perClient: 60,
    total: 1200,
    windowMs: 10 * 60_000,
    ...options.ownerRequests?.writes,
    now: ownerNow,
  });
  const reads = new RateLimiter({
    perClient: 600,
    total: 20_000,
    windowMs: 10 * 60_000,
    ...options.ownerRequests?.reads,
    now: ownerNow,
  });
  const wallet = sessionRoutes(app, {
    db,
    chainId: chain.deployment.chainId,
    now: ownerNow,
    writes,
  });
  app.get("/health", async (c) => {
    await db.pool.query("SELECT 1");
    return c.json({ ok: true, chainId: chain.deployment.chainId });
  });
  // The latest posted score, with its binding level, coverage and held-out seed when the report
  // has them (bring your own agent).
  app.get("/agents/:id/score", async (c) => {
    const id = uint.parse(c.req.param("id"));
    const r = await db.pool.query(
      `SELECT s.id AS "runId",s.signed,s.tx_hash,r.report FROM attestations s
       JOIN ratings r ON r.id=s.id WHERE s.agent_id=$1 ORDER BY s.created_at DESC LIMIT 1`,
      [`${chain.deployment.chainId}:${id}`],
    );
    if (!r.rowCount) return c.json({ error: "score not found" }, 404);
    const { report, ...row } = r.rows[0];
    return c.json({
      ...row,
      ...ratingFacts(row.signed?.attestation?.teeMeasurement, report),
      // Every rating of the agent, failed ones included, next to the score they didn't replace
      // (the first page; GET /self/agents/:id/ratings has the rest).
      ...(await ratingHistory(`${chain.deployment.chainId}:${id}`)),
    });
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
    const agentKey = `${chain.deployment.chainId}:${input.agentId}`;
    // After a stop the agent caused, its score no longer stands: no new cover until a complete
    // rating posts. Rerolling a bad rating by crashing gains nothing. Checked whatever the agent
    // is registered as now, so registering it again can't lift it.
    const { superseded } = await db.agentStanding(agentKey);
    if (superseded)
      return c.json(
        {
          error: `this agent's score is superseded: its latest rating was stopped by the agent (${superseded.reason}); cover waits for a complete rating`,
          ...(await ratingHistory(agentKey)),
        },
        409,
      );
    const record = await db.agentRecord(agentKey);
    // Whether the score's agent is one its operator runs (cover capped by binding: underwriting
    // policy, not score) comes from the rating that posted the score, never from a later
    // registration. A score of an earlier registration prices no cover.
    let operatorRun = false;
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
      async ({ reportHash }) => {
        const rating = await db.ratingBehindScore(agentKey, reportHash);
        if (rating && !rating.current)
          return {
            refused:
              "this agent was registered again after its current score was posted; cover waits for a complete rating of its current registration",
          };
        // A score this service didn't post: the registration is all there is to go on.
        operatorRun = rating
          ? rating.kind === REMOTE_KIND
          : record?.enabled === true && (record.config as { kind?: string }).kind === REMOTE_KIND;
        return {
          capByBinding: operatorRun,
          caps: options.coverCaps ?? UNDERWRITING_COVER_CAP_USD,
        };
      },
    );
    await db.pool.query("INSERT INTO quotes(id,chain_id,agent_id,signed) VALUES($1,$2,$3,$4)", [
      randomUUID(),
      chain.deployment.chainId,
      input.agentId,
      json(signed),
    ]);
    return c.json({ ...signed, ...(operatorRun ? await ratingHistory(agentKey) : {}) }, 201);
  });
  /** An agent's standing and its latest ratings, failed ones included, for scores and quotes. */
  async function ratingHistory(agentKey: string) {
    const [page, standing] = await Promise.all([
      db.ratingAttempts(agentKey),
      db.agentStanding(agentKey),
    ]);
    return {
      attempts: page.items,
      attemptsTotal: page.total,
      superseded: standing.superseded,
      cooldownUntil: standing.cooldownUntil,
    };
  }
  app.post("/arena/runs", async (c) => {
    const { agentId } = z.strictObject({ agentId: uint }).parse(await c.req.json());
    const id = `${chain.deployment.chainId}:${agentId}`;
    return c.json({ runId: await db.enqueue(id) }, 202);
  });
  for (const path of ["/arena/runs/:id", "/arena/runs/:id/report"])
    app.get(path, async (c) => {
      const id = z.uuid().parse(c.req.param("id"));
      // A preview's rating too, but only to its owner's session: "not found" to anyone else.
      const r = await db.pool.query(
        `SELECT id,status,report,report_json,error,created_at,code_hash AS "codeHash",
           code_source AS "codeSource", (preview_id IS NOT NULL) AS preview, charged_owner
         FROM ratings WHERE id=$1`,
        [id],
      );
      if (!r.rowCount) return c.json({ error: "run not found" }, 404);
      const { charged_owner: chargedOwner, ...row } = r.rows[0];
      if (row.preview) {
        const viewer = await wallet(c).catch(() => undefined);
        if (!viewer || viewer !== chargedOwner) return c.json({ error: "run not found" }, 404);
      }
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
      // How far it has got, and a rough estimate of the time left, from its published episodes.
      const progress = await db.runProgress(id);
      const elapsed =
        progress.startedAt && progress.lastAt
          ? progress.lastAt.getTime() - progress.startedAt.getTime()
          : 0;
      const etaSeconds =
        row.status === "running" && progress.total && progress.done > 1
          ? Math.round(((elapsed / (progress.done - 1)) * (progress.total - progress.done)) / 1000)
          : null;
      return c.json({
        ...row,
        ...(row.report ? ratingFacts(undefined, row.report) : {}),
        // Counts and an ETA only: no verdicts while a remote rating runs.
        progress: {
          done: progress.done,
          total: progress.total,
          etaSeconds,
          startedAt: progress.startedAt?.toISOString() ?? null,
        },
      });
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
    const { class: cls, submission, ...q } = bountiesQuery.parse(c.req.query());
    return c.json(
      await db.bounties(chain.deployment.chainId, {
        ...q,
        ...(cls ? { attackClass: cls } : {}),
        ...(submission ? { submissionId: submission } : {}),
      }),
    );
  });
  // Episodes come as numbered pages of a snapshot: the first request returns `through`, the
  // newest event id, and later pages pass it back, so a page shows the same rows however many
  // episodes arrive meanwhile. A live stream opened after `through` brings the new ones.
  // Counts are per snapshot and filters (all but the outcome), so turning pages reuses them;
  // each is kept a minute, and the cache is bounded.
  const countsCacheMs = options.episodeCountsCacheMs ?? 60_000;
  const countsCache = new Map<string, { at: number; counts: EpisodeCounts }>();
  // Whether an episode's attack is published is decided by the library itself (attacks/), not
  // by its id: a bounty hunter can name an attack anything.
  const publishedIds = loadAttackLibrary().map((a) => a.id);
  const isPublished = new Set(publishedIds);
  const withPublished = <T extends { attackId: string | null }>(e: T) => ({
    ...e,
    published: e.attackId === null ? null : isPublished.has(e.attackId),
  });
  app.get("/episodes", async (c) => {
    const {
      class: cls,
      attack,
      page,
      limit,
      through: asked,
      outcome,
      agentId,
      ...rest
    } = episodesQuery.parse(c.req.query());
    const through = asked ?? (await db.latestEventId());
    const scope: EpisodeFilters = {
      ...rest,
      ...(cls ? { attackClass: cls } : {}),
      ...(attack ? { attackId: attack } : {}),
      ...(agentId ? { agentId, chainId: chain.deployment.chainId } : {}),
    };
    const key = JSON.stringify([scope, through]);
    scope.publishedIds = publishedIds;
    let cached = countsCache.get(key);
    if (!cached || Date.now() - cached.at >= countsCacheMs) {
      cached = { at: Date.now(), counts: await db.episodeCounts(scope, through) };
      if (countsCache.size > 500) countsCache.clear();
      countsCache.set(key, cached);
    }
    const result = await db.episodes(
      { ...scope, ...(outcome ? { outcome } : {}) },
      {
        through,
        counts: cached.counts,
        ...(page ? { page } : {}),
        ...(limit ? { limit } : {}),
      },
    );
    return c.json({
      ...result,
      items: result.items.map(withPublished),
      through,
      counts: cached.counts,
    });
  });
  // One episode with its detail, for the Arena's episode page. Unpublished attacks' text is never
  // in it: the worker leaves it out when it publishes the episode (publicEpisode).
  app.get("/episodes/:eventId", async (c) => {
    const eventId = uint.parse(c.req.param("eventId"));
    const episode = await db.episode(eventId);
    if (!episode) return c.json({ error: "episode not found; older episodes are pruned" }, 404);
    return c.json(withPublished(episode));
  });
  selfServeRoutes(app, {
    db,
    chain,
    ...(options.selfServe ? { limits: options.selfServe } : {}),
    ...(options.gatewayUrl ? { gatewayUrl: options.gatewayUrl } : {}),
    ...(options.coverCaps ? { coverCaps: options.coverCaps } : {}),
    agentUrls: Boolean(options.secrets),
  });
  const ownDomains = [
    ...ownDomainsFrom([...(options.webOrigins ?? []), options.gatewayUrl]),
    ...(options.ownDomains ?? []),
  ];
  const streams = new PollStreams();
  ownerRoutes(app, {
    db,
    chain,
    policy: options.selfServe?.remote ?? DEFAULT_REMOTE_POLICY,
    wallet,
    now: ownerNow,
    writes,
    reads,
    ...(options.secrets ? { secrets: options.secrets } : {}),
    // The API's own Agent URL client (the gateway has its own): it refuses Bonded's hosts and
    // rate-limits calls per URL host.
    verifyAgentUrl:
      options.verifyAgentUrl ??
      gatewayUrlVerifier(
        new AgentUrlClient({
          refusedHosts: ownDomains,
          ...(options.allowLoopbackUrls ? { allowLoopback: true } : {}),
        }),
      ),
    ownDomains,
    ...(options.gatewayUrl ? { gatewayUrl: options.gatewayUrl } : {}),
    ...(options.allowLoopbackUrls ? { allowLoopbackUrls: true } : {}),
    ...(options.email ? { email: options.email } : {}),
    streams,
    ...(options.ownerRequests?.checksPerClientHourly
      ? { checksPerClientHourly: options.ownerRequests.checksPerClientHourly }
      : {}),
  });
  notificationRoutes(app, {
    db,
    wallet,
    writes,
    reads,
    ...(options.secrets ? { secrets: options.secrets } : {}),
    ...(options.email ? { email: options.email } : {}),
    ownDomains,
    ...(options.allowLoopbackUrls ? { allowLoopbackUrls: true } : {}),
  });
  observedRatesRoute(app, { db, chainId: chain.deployment.chainId });
  libraryRoutes(app, { db, chainId: chain.deployment.chainId });
  sentinelRoutes(app, {
    db,
    chain,
    ...(options.sentinel ? { sentinel: options.sentinel } : {}),
    ...(options.sentinelLimits ? { limits: options.sentinelLimits } : {}),
  });
  app.get("/events", async (c) => {
    const after = uint.parse(c.req.header("Last-Event-ID") ?? c.req.query("after") ?? "0");
    const runId = c.req.query("runId");
    if (runId) z.uuid().parse(runId);
    return events.open(c, after, runId);
  });
  return Object.assign(app, {
    close: async () => {
      streams.close();
      await events.close();
    },
  });
}
