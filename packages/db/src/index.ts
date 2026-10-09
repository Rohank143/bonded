import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
export * from "./schema.js";
export type Connection = pg.PoolClient;
/** Serialize public payloads without losing integer precision. */
export const json = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

/** One agent's TEE row (migration 0004). */
export interface TeeCheckRow {
  status: string;
  detail: string | null;
  measurement: string | null;
  ratedMeasurement: string | null;
  ratedReportHash: string | null;
  evmAddress: string | null;
  blockingStatus: string | null;
  checkedAt: Date;
  verifiedAt: Date | null;
}

/** A bounty under validation, leased by one worker (migration 0006). */
export interface BountyJob {
  chainId: number;
  submissionId: string;
  token: string;
  hunter: string;
  attempts: number;
  broadcastPending: boolean;
  pendingTxHash: string | null;
  /** The nonce the pending send was given before broadcast (migration 0008). */
  pendingNonce: number | null;
  spec: unknown;
  /** The verdict an earlier attempt recorded before sending its transaction, if any. */
  verdict: unknown;
}

/** A bounty as the public sees it: no payload, which stays private (docs/disclosures). */
export interface BountySummary {
  submissionId: string;
  hunter: string;
  specUri: string;
  attackId: string;
  attackClass: string;
  title: string;
  surfaces: string[];
  status: string;
  reward: string | null;
  reason: string | null;
  txHash: string | null;
  createdAt: Date;
}

/** One Arena episode from the live events table (topic `rating.episode`). */
export interface EpisodeSummary {
  eventId: string;
  runId: string;
  index: number;
  total: number;
  attackId: string | null;
  attackClass: string | null;
  breached: boolean;
  lossUsd: number;
  frozen: boolean;
  /** The rated agent's on-chain id, when the run is in this database's ratings. */
  agentId: string | null;
  /**
   * Why the vault ruled as it did (`Ruling` in @bonded/arena): breach, vault_blocked,
   * guard_blocked, ignored, unseen, no_verdict or control. Null for episodes published before
   * rulings were recorded.
   */
  ruling: string | null;
  /** When the episode started (ISO 8601); for older episodes, when it was published. */
  at: string | null;
}

/** One episode with its detail (`EpisodeDetail` in @bonded/arena), for the episode page. */
export interface EpisodeRecord extends EpisodeSummary {
  agent: string | null;
  durationMs: number | null;
  /** Null for episodes published before the detail was recorded. */
  detail: unknown;
}

/** An episode event's row as the lists show it. */
/** The parts of a rating.episode payload the lists read (published by the rating worker). */
interface EpisodePayload {
  runId: string;
  index: number;
  total?: number;
  episode?: {
    attackId?: string | null;
    attackClass?: string | null;
    ruling?: unknown;
    startedAt?: unknown;
    verdict?: { breached?: boolean; totalLossUsd?: number; frozen?: boolean };
  };
}

function episodeSummary(row: {
  id: unknown;
  payload: EpisodePayload;
  created_at?: Date;
  onchain: string | null;
}): EpisodeSummary {
  const p = row.payload;
  return {
    eventId: String(row.id),
    runId: String(p.runId),
    index: Number(p.index),
    total: Number(p.total ?? 0),
    attackId: p.episode?.attackId ?? null,
    attackClass: p.episode?.attackClass ?? null,
    breached: p.episode?.verdict?.breached === true,
    lossUsd: Number(p.episode?.verdict?.totalLossUsd ?? 0),
    frozen: p.episode?.verdict?.frozen === true,
    agentId: row.onchain ?? null,
    ruling: typeof p.episode?.ruling === "string" ? p.episode.ruling : null,
    // When the episode started; older episodes didn't record it, so when it was published.
    at:
      typeof p.episode?.startedAt === "string"
        ? p.episode.startedAt
        : (row.created_at?.toISOString() ?? null),
  };
}

/** How an episode went: a control has no attack; otherwise the vault held or recorded a breach. */
export type EpisodeOutcome = "held" | "breach" | "control";

/** One numbered page of a list: `page` is 1-based, `pages` is at least 1. */
export interface Page<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

/** Page sizes the list endpoints accept. */
export const PAGE_LIMIT = { default: 25, max: 100 } as const;

const clampLimit = (limit?: number) =>
  Math.min(Math.max(Math.trunc(limit ?? PAGE_LIMIT.default), 1), PAGE_LIMIT.max);
/** The page to read: past the last page reads the last page, so a shrinking list never shows nothing. */
const pageOf = (page: number | undefined, total: number, limit: number) => {
  const pages = Math.max(1, Math.ceil(total / limit));
  const p = Math.min(Math.max(Math.trunc(page ?? 1), 1), pages);
  return { page: p, pages, offset: (p - 1) * limit };
};

/** Episode filters. Everything but `outcome` also narrows the outcome counts. */
export interface EpisodeFilters {
  runId?: string;
  /** One attack's episodes, by its id (e.g. "A4-honeypot-otc-004"). */
  attackId?: string;
  /** An on-chain agent id; with `chainId`, its ratings' episodes only. */
  agentId?: string;
  chainId?: number;
  attackClass?: string;
  /** Held-out and bounty attacks (never published), or the public library. */
  source?: "held-out" | "library";
  /**
   * The published library's attack ids (attacks/ in the repository). With them, `source` is
   * decided by the library itself; without, by the id pattern, which misses a bounty attack
   * whose hunter chose an id without "bounty" in it.
   */
  publishedIds?: readonly string[];
  /** Only episodes from the last hour, day or week. */
  since?: "1h" | "24h" | "7d";
  outcome?: EpisodeOutcome;
}
const SINCE: Record<NonNullable<EpisodeFilters["since"]>, string> = {
  "1h": "1 hour",
  "24h": "1 day",
  "7d": "7 days",
};
/** The same reading as the web's: held-out and bounty attacks have ids that say so. */
const PRIVATE_ATTACK = "e.payload->'episode'->>'attackId' ~* '(held-out|bounty)'";

/** One attack's record in the Arena episodes still on record. */
export interface AttackStats {
  episodes: number;
  breaches: number;
  runs: number;
  lastAt: Date | null;
}

/** Episode counts by outcome. */
export type EpisodeCounts = Record<EpisodeOutcome | "total", number>;

// The SQL for each outcome, matching the web's reading: no attack class means a control.
const OUTCOME_SQL: Record<EpisodeOutcome, string> = {
  control: "e.payload->'episode'->>'attackClass' IS NULL",
  breach:
    "e.payload->'episode'->>'attackClass' IS NOT NULL AND (e.payload->'episode'->'verdict'->>'breached')::boolean IS TRUE",
  held: "e.payload->'episode'->>'attackClass' IS NOT NULL AND (e.payload->'episode'->'verdict'->>'breached')::boolean IS NOT TRUE",
};

/**
 * A runner counts as connected while its last heartbeat is this recent: three of the runner's
 * 15-second heartbeats (RUNNER_HEARTBEAT_MS in @bondedhq/shared).
 */
export const RUNNER_FRESH_MS = 45_000;

/** A live runner token, as the gateway's validator needs it (migration 0014). */
export interface RunnerTokenRecord {
  tokenId: string;
  /** The agent's row id, "<chain id>:<agent id>". */
  agentKey: string;
  chainId: number;
  agentId: string;
  config: unknown;
  /** Who made the token: the agent's registry owner when it was made. */
  createdBy: string;
}

/** What a runner said when it connected. */
export interface RunnerHello {
  runnerVersion: string;
  mode: string;
  teeUrl?: string | undefined;
}

/** An agent's runner token and runner, as the owner's page shows them. */
export interface RunnerStatus {
  /** The live token's id and age; never the token. Null when there is none. */
  token: { id: string; createdAt: Date } | null;
  /** The runner last seen with the live token, if any. */
  runner: {
    connected: boolean;
    connectedAt: Date;
    lastHeartbeatAt: Date;
    disconnectedAt: Date | null;
    runnerVersion: string | null;
    mode: string | null;
    teeUrl: string | null;
  } | null;
  /** The latest rating the live loop skipped, and why. */
  lastSkip: { cause: string; reason: string; at: Date } | null;
}

/**
 * SQL: whether agent `a` has a connected runner on a live token right now, in the mode the agent
 * is registered for (a runner started in another mode can't run its episodes).
 */
const RUNNER_CONNECTED = `EXISTS (SELECT 1 FROM runner_presence p JOIN runner_tokens t ON t.id=p.token_id
  WHERE p.agent_id=a.id AND p.connected AND t.revoked_at IS NULL
    AND t.created_by IS NOT DISTINCT FROM a.owner
    AND p.mode IS NOT DISTINCT FROM a.config->>'mode'
    AND p.last_heartbeat_at > now() - make_interval(secs => ${RUNNER_FRESH_MS / 1000}))`;

/** Which ratings a worker takes (see `takeJob`). */
export type RatingLane = "builtin" | "remote";

/** A rating's progress: episodes published so far, of how many, since when. */
export interface RunProgress {
  done: number;
  total: number | null;
  startedAt: Date | null;
  lastAt: Date | null;
}

/** One rating of an agent, as its history shows it. */
export interface RatingAttempt {
  runId: string;
  status: string;
  /** The system's own reason, when it failed. */
  error: string | null;
  /** It stopped because of the agent (crash, timeout, too slow). */
  agentCaused: boolean;
  /** What the agent or its runner reported: the operator's words, shown as such. */
  agentReport: string | null;
  createdAt: Date;
  /** The score, when the rating finished and was posted. */
  score: number | null;
}

/** Where an operator-run agent stands after its ratings (migration 0017). */
export interface AgentStanding {
  failuresInRow: number;
  /** Set after an agent-caused stop: the current score no longer stands. */
  superseded: { since: Date; reason: string } | null;
  cooldownUntil: Date | null;
}

/** Limits on remote ratings, all of them counted over the last 24 hours. */
export interface RemoteQuota {
  nowMs: number;
  /** Per owner, across their agents (default 3). */
  perOwnerDaily: number;
  /** Per agent (default 2). */
  perAgentDaily: number;
  /** For the whole remote lane on the chain (default 20). */
  laneDaily: number;
}

/** Why a remote rating can't be queued now. */
export type RemoteRefusal =
  | { refused: "cooldown"; nextAt: Date }
  | { refused: "owner-daily" }
  | { refused: "agent-daily" }
  | { refused: "lane-daily" };

/** Cooldown after `failures` agent-caused stops in a row: 1 h, doubling, at most 48 h. */
export function remoteCooldownMs(failures: number): number {
  return Math.min(48, 2 ** Math.max(0, failures - 1)) * 3_600_000;
}

/** Raised when a caller tries to queue an agent outside the configured set. */
export class AgentNotConfiguredError extends Error {}

/** SQL transactions own queue leases, ingestion cursors and durable live events. */
export class Database {
  readonly pool: pg.Pool;
  readonly orm;
  /** Bound connection waits so saturation cannot leave requests waiting indefinitely. */
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 15, connectionTimeoutMillis: 5000 });
    this.pool.on("error", () => console.error("Postgres idle connection failed"));
    this.orm = drizzle(this.pool);
  }
  /** Run a callback atomically and always release its connection. */
  async transaction<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const value = await fn(c);
      await c.query("COMMIT");
      return value;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  /** Apply ordered migrations once under a cross-process migration lock. */
  async migrate() {
    const migrations = [
      "0001_services.sql",
      "0002_report_bytes.sql",
      "0003_agent_availability.sql",
      "0004_tee_checks.sql",
      "0005_tee_rating_version.sql",
      "0006_bounties.sql",
      "0007_bounty_broadcasts.sql",
      "0008_bounty_nonce.sql",
      "0009_self_serve_agents.sql",
      "0010_held_out_attacks.sql",
      "0011_list_pagination.sql",
      "0012_attack_index.sql",
      "0013_sentinel_checks.sql",
      "0014_runner_tokens.sql",
      "0015_breach_details.sql",
      "0016_held_out_payloads.sql",
      "0017_agent_standing.sql",
      "0018_rating_registration.sql",
      "0019_sentinel_cascade.sql",
    ];
    await this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7001)");
      await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)");
      for (const [index, file] of migrations.entries()) {
        const version = index + 1;
        const done = await c.query("SELECT 1 FROM schema_migrations WHERE version=$1", [version]);
        if (!done.rowCount) {
          await c.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
          await c.query("INSERT INTO schema_migrations VALUES ($1)", [version]);
        }
      }
    });
  }
  /** Persist before notifying; event IDs are serialized through commit for safe SSE replay. */
  async publish(topic: string, payload: unknown, c?: Connection): Promise<void> {
    if (!c) return this.transaction((tx) => this.publish(topic, payload, tx));
    // Serialize allocation through commit: SSE cannot skip a late committing lower ID.
    await c.query("SELECT pg_advisory_xact_lock(7002)");
    const r = await c.query("INSERT INTO events(topic,payload) VALUES($1,$2) RETURNING id", [
      topic,
      json(payload),
    ]);
    await c.query("SELECT pg_notify('bonded_events',$1)", [r.rows[0].id]);
  }
  /** Record one Sentinel check: never the action or the inputs, only the outcome. */
  async recordSentinelCheck(
    chainId: number,
    agentId: string,
    check: {
      manipulated: number | null;
      blocked: boolean | null;
      latencyMs: number;
      status?: "success" | "error";
      pipelineHash?: string;
      model?: string;
      escalated?: boolean;
      primaryLatencyMs?: number;
      fallbackLatencyMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      llmCostUsd?: number;
    },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO sentinel_checks(chain_id,agent_id,manipulated,blocked,latency_ms,status,
        pipeline_hash,model,escalated,primary_latency_ms,fallback_latency_ms,input_tokens,output_tokens,llm_cost_usd)
       VALUES($1,$2::numeric,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        chainId,
        agentId,
        check.manipulated,
        check.blocked,
        Math.round(check.latencyMs),
        check.status ?? "success",
        check.pipelineHash,
        check.model,
        check.escalated,
        check.primaryLatencyMs === undefined ? null : Math.round(check.primaryLatencyMs),
        check.fallbackLatencyMs === undefined ? null : Math.round(check.fallbackLatencyMs),
        check.inputTokens,
        check.outputTokens,
        check.llmCostUsd,
      ],
    );
  }
  /** Durable metrics for one deployed pipeline. Unknown legacy or failed-call cost stays unknown. */
  async sentinelMetrics(chainId: number, since: Date, pipelineHash: string) {
    const r = await this.pool.query(
      `SELECT count(*)::int AS checks,
        count(*) FILTER (WHERE status='error')::int AS errors,
        count(*) FILTER (WHERE escalated)::int AS escalations,
        count(escalated)::int AS routed,
        count(llm_cost_usd)::int AS costed,
        sum(llm_cost_usd)::float8 AS cost,
        sum(input_tokens)::float8 AS input_tokens, sum(output_tokens)::float8 AS output_tokens,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY primary_latency_ms) AS primary_p50,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY primary_latency_ms) AS primary_p95,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY fallback_latency_ms) AS fallback_p50,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY fallback_latency_ms) AS fallback_p95
       FROM sentinel_checks WHERE chain_id=$1 AND checked_at >= $2 AND pipeline_hash=$3`,
      [chainId, since, pipelineHash],
    );
    const m = r.rows[0];
    return {
      checks: m.checks as number,
      errors: m.errors as number,
      escalations: m.escalations as number,
      escalationRate: m.routed ? m.escalations / m.routed : null,
      knownCostChecks: m.costed as number,
      llmCostUsd: m.checks && m.costed === m.checks ? m.cost : null,
      llmUsdPer1000: m.checks && m.costed === m.checks ? (m.cost * 1000) / m.checks : null,
      inputTokens: m.input_tokens as number | null,
      outputTokens: m.output_tokens as number | null,
      latencyMs: { p50: m.p50 as number | null, p95: m.p95 as number | null },
      primaryLatencyMs: {
        p50: m.primary_p50 as number | null,
        p95: m.primary_p95 as number | null,
      },
      fallbackLatencyMs: {
        p50: m.fallback_p50 as number | null,
        p95: m.fallback_p95 as number | null,
      },
    };
  }
  /** Sentinel checks since `since`, for one agent or every agent on the chain. */
  async sentinelCheckCounts(
    chainId: number,
    since: Date,
    agentId?: string,
  ): Promise<{ checks: number; blocked: number; lastAt: Date | null }> {
    const r = await this.pool.query(
      `SELECT count(*)::int AS checks, count(*) FILTER (WHERE blocked)::int AS blocked,
        max(checked_at) AS last_at
      FROM sentinel_checks
      WHERE chain_id=$1 AND checked_at >= $2 AND ($3::numeric IS NULL OR agent_id = $3::numeric)`,
      [chainId, since, agentId ?? null],
    );
    const row = r.rows[0];
    return { checks: row.checks, blocked: row.blocked, lastAt: row.last_at };
  }
  /** Delete Sentinel check records from before `before`. */
  async pruneSentinelChecks(before: Date): Promise<number> {
    const r = await this.pool.query("DELETE FROM sentinel_checks WHERE checked_at < $1", [before]);
    return r.rowCount ?? 0;
  }
  /**
   * Delete live events created before `before`, oldest first, in bounded batches so a large
   * backlog never holds one long transaction. Ratings, reports and attestations are kept.
   * An SSE client resuming from a pruned Last-Event-ID continues from the oldest kept event.
   */
  async pruneEvents(before: Date, batchSize = 10_000): Promise<number> {
    // A zero batch would delete nothing and never reach the exit condition.
    if (!Number.isSafeInteger(batchSize) || batchSize < 1)
      throw new RangeError("batchSize must be a positive integer");
    let deleted = 0;
    for (;;) {
      const r = await this.pool.query(
        "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at < $1 ORDER BY id LIMIT $2)",
        [before, batchSize],
      );
      deleted += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < batchSize) return deleted;
    }
  }
  /** Replace one chain's runnable set without deleting rating or attestation history. */
  async reconcileAgents(chainId: number, agents: { agentId: string; config: unknown }[]) {
    await this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7005,$1)", [chainId]);
      const ids = agents.map((agent) => `${chainId}:${agent.agentId}`);
      // The file is the complete set of operator agents; agents registered by their owners
      // (source 'user') are not the file's to remove.
      await c.query(
        "UPDATE agents SET enabled=false WHERE chain_id=$1 AND source='operator' AND NOT (id=ANY($2::text[]))",
        [chainId, ids],
      );
      for (const agent of agents)
        await c.query(
          "INSERT INTO agents(id,chain_id,agent_id,config,enabled) VALUES($1,$2,$3,$4,true) ON CONFLICT(id) DO UPDATE SET config=$4,enabled=true,source='operator',owner=NULL",
          [`${chainId}:${agent.agentId}`, chainId, agent.agentId, json(agent.config)],
        );
      const cancelled = await c.query(
        `UPDATE jobs j SET status='failed',lease_until=NULL
        FROM ratings r JOIN agents a ON a.id=r.agent_id
        WHERE j.id=r.id AND a.chain_id=$1 AND NOT a.enabled AND j.status IN ('queued','running') RETURNING j.id`,
        [chainId],
      );
      for (const row of cancelled.rows) {
        await c.query(
          "UPDATE ratings SET status='failed',error='agent removed from configuration' WHERE id=$1",
          [row.id],
        );
        await this.publish("rating.failed", { runId: row.id }, c);
      }
    });
  }
  /**
   * Store an agent registered by its owner (self-serve). Returns false, changing nothing, if the
   * operator already configures this agent: the operator's config wins.
   */
  async upsertUserAgent(chainId: number, agentId: string, owner: string, config: unknown) {
    const r = await this.pool.query(
      `INSERT INTO agents(id,chain_id,agent_id,config,enabled,source,owner) VALUES($1,$2,$3,$4,true,'user',$5)
       ON CONFLICT(id) DO UPDATE SET config=$4,enabled=true,owner=$5 WHERE agents.source='user'
       RETURNING id`,
      [`${chainId}:${agentId}`, chainId, agentId, json(config), owner.toLowerCase()],
    );
    return r.rowCount === 1;
  }
  /** An agent's row: where its config came from, its owner and config, and its latest rating. */
  async agentRecord(id: string) {
    const r = await this.pool.query(
      `SELECT a.source,a.owner,a.config,a.enabled,
        (SELECT max(created_at) FROM ratings WHERE agent_id=a.id) AS last_rating_at
       FROM agents a WHERE a.id=$1`,
      [id],
    );
    return r.rows[0] as
      | {
          source: "operator" | "user";
          owner: string | null;
          config: unknown;
          enabled: boolean;
          last_rating_at: Date | null;
        }
      | undefined;
  }
  /**
   * Queue a self-serve rating if both quotas allow it: none for this agent within `perAgentMs`,
   * and fewer than `dailyCap` self-serve ratings on the chain in the last 24 hours. The checks and
   * the insert run in one transaction under a per-chain lock, so parallel requests can't all see
   * the same allowance.
   */
  async enqueueUserRating(
    id: string,
    chainId: number,
    quota: { nowMs: number; perAgentMs: number; dailyCap: number; remote?: RemoteQuota },
  ): Promise<
    { runId: string } | { refused: "hourly"; nextAt: Date } | { refused: "daily" } | RemoteRefusal
  > {
    return this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7006,$1)", [chainId]);
      const last = (
        await c.query("SELECT max(created_at) AS t FROM ratings WHERE agent_id=$1", [id])
      ).rows[0].t as Date | null;
      if (last && quota.nowMs - last.getTime() < quota.perAgentMs)
        return { refused: "hourly", nextAt: new Date(last.getTime() + quota.perAgentMs) };
      // An operator-run agent has its own lane and caps, so it never uses up the built-in
      // designs' daily allowance (and they never use up its).
      if (quota.remote) {
        const refused = await this.remoteQuotaIn(c, id, quota.remote);
        if (refused) return refused;
        return { runId: await this.enqueueIn(c, id, new Date(quota.nowMs)) };
      }
      const today = (
        await c.query(
          `SELECT count(*)::int AS n FROM ratings r JOIN agents a ON a.id=r.agent_id
           WHERE a.chain_id=$1 AND a.source='user' AND r.kind<>'remote' AND r.created_at>=$2`,
          [chainId, new Date(quota.nowMs - 86_400_000)],
        )
      ).rows[0].n as number;
      if (today >= quota.dailyCap) return { refused: "daily" };
      // Stamped with the same clock the quotas use, so the next check compares like with like.
      return { runId: await this.enqueueIn(c, id, new Date(quota.nowMs)) };
    });
  }
  /**
   * Store a new runner token's hash for an agent, revoking the one it replaces, in one transaction.
   * Refused when the request was signed no later than the last token request for this agent, so a
   * captured signature can't be replayed.
   */
  async createRunnerToken(
    agentKey: string,
    token: { hash: string; createdBy: string; signedAt: number },
  ): Promise<{ id: string; createdAt: Date } | { refused: "replayed" }> {
    return this.transaction(async (c) => {
      await c.query("SELECT 1 FROM agents WHERE id=$1 FOR UPDATE", [agentKey]);
      if (await this.runnerRequestSeen(c, agentKey, token.signedAt)) return { refused: "replayed" };
      await c.query(
        "UPDATE runner_tokens SET revoked_at=now(),revoked_signed_at=$2 WHERE agent_id=$1 AND revoked_at IS NULL",
        [agentKey, token.signedAt],
      );
      const r = await c.query(
        `INSERT INTO runner_tokens(id,agent_id,token_hash,created_by,signed_at) VALUES($1,$2,$3,$4,$5)
         RETURNING id,created_at`,
        [randomUUID(), agentKey, token.hash, token.createdBy.toLowerCase(), token.signedAt],
      );
      return { id: r.rows[0].id as string, createdAt: r.rows[0].created_at as Date };
    });
  }
  /** Revoke an agent's live runner token. Refused like `createRunnerToken` for a replay. */
  async revokeRunnerToken(
    agentKey: string,
    signedAt: number,
  ): Promise<{ revoked: number } | { refused: "replayed" }> {
    return this.transaction(async (c) => {
      await c.query("SELECT 1 FROM agents WHERE id=$1 FOR UPDATE", [agentKey]);
      if (await this.runnerRequestSeen(c, agentKey, signedAt)) return { refused: "replayed" };
      const r = await c.query(
        "UPDATE runner_tokens SET revoked_at=now(),revoked_signed_at=$2 WHERE agent_id=$1 AND revoked_at IS NULL",
        [agentKey, signedAt],
      );
      await c.query(
        "UPDATE runner_presence SET connected=false,disconnected_at=now() WHERE agent_id=$1 AND connected",
        [agentKey],
      );
      return { revoked: r.rowCount ?? 0 };
    });
  }
  /** Whether a runner token request for this agent was already signed at or after `signedAt`. */
  private async runnerRequestSeen(c: Connection, agentKey: string, signedAt: number) {
    const r = await c.query(
      `SELECT 1 FROM runner_tokens WHERE agent_id=$1
         AND greatest(signed_at, coalesce(revoked_signed_at, 0)) >= $2 LIMIT 1`,
      [agentKey, signedAt],
    );
    return Boolean(r.rowCount);
  }
  /** The live token with this hash, for an enabled agent; undefined for anything else. */
  async runnerToken(hash: string): Promise<RunnerTokenRecord | undefined> {
    const r = await this.pool.query(
      `SELECT t.id,t.agent_id,t.created_by,a.chain_id,a.agent_id::text AS onchain,a.config FROM runner_tokens t
       JOIN agents a ON a.id=t.agent_id
       WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND a.enabled`,
      [hash],
    );
    const row = r.rows[0];
    return (
      row && {
        tokenId: row.id,
        agentKey: row.agent_id,
        chainId: row.chain_id,
        agentId: row.onchain,
        config: row.config,
        createdBy: row.created_by,
      }
    );
  }
  /**
   * Record that a runner connected for an agent, on the agent's live token, replacing any earlier
   * connection. Returns the connection's id, or undefined, recording nothing, if the agent has no
   * live token (it was revoked since the runner's token was checked).
   */
  async runnerConnected(agentKey: string, hello: RunnerHello): Promise<string | undefined> {
    const connection = randomUUID();
    const r = await this.pool.query(
      `INSERT INTO runner_presence(agent_id,token_id,connection_id,connected,connected_at,last_heartbeat_at,
                                   disconnected_at,runner_version,mode,tee_url)
       SELECT agent_id,id,$2,true,now(),now(),NULL,$3,$4,$5 FROM runner_tokens
       WHERE agent_id=$1 AND revoked_at IS NULL
       ON CONFLICT(agent_id) DO UPDATE SET token_id=EXCLUDED.token_id,connection_id=EXCLUDED.connection_id,
         connected=true,connected_at=now(),last_heartbeat_at=now(),disconnected_at=NULL,
         runner_version=EXCLUDED.runner_version,mode=EXCLUDED.mode,tee_url=EXCLUDED.tee_url
       RETURNING agent_id`,
      [agentKey, connection, hello.runnerVersion, hello.mode, hello.teeUrl ?? null],
    );
    return r.rowCount === 1 ? connection : undefined;
  }
  /**
   * A heartbeat on a connection. Returns false when its token was revoked or a newer connection
   * replaced it: the gateway should then drop it.
   */
  async runnerHeartbeat(connectionId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE runner_presence p SET last_heartbeat_at=now() FROM runner_tokens t
       WHERE p.connection_id=$1 AND t.id=p.token_id AND p.connected AND t.revoked_at IS NULL`,
      [connectionId],
    );
    return r.rowCount === 1;
  }
  /** A connection closed. A newer connection for the same agent is left alone. */
  async runnerDisconnected(connectionId: string): Promise<void> {
    await this.pool.query(
      "UPDATE runner_presence SET connected=false,disconnected_at=now() WHERE connection_id=$1 AND connected",
      [connectionId],
    );
  }
  /** Mark the agent's runner disconnected: its next heartbeat fails, so it must connect again. */
  async dropRunner(agentKey: string): Promise<void> {
    await this.pool.query(
      "UPDATE runner_presence SET connected=false,disconnected_at=now() WHERE agent_id=$1 AND connected",
      [agentKey],
    );
  }
  /** Whether the agent has a connected runner on a live token right now. */
  async runnerIsConnected(agentKey: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT ${RUNNER_CONNECTED} AS ok FROM agents a WHERE a.id=$1`,
      [agentKey],
    );
    return r.rows[0]?.ok === true;
  }
  /** The agent's live token (never the token itself), its runner and the latest skipped rating. */
  async runnerStatus(agentKey: string): Promise<RunnerStatus> {
    const [token, presence, skip] = await Promise.all([
      this.pool.query(
        "SELECT id,created_at FROM runner_tokens WHERE agent_id=$1 AND revoked_at IS NULL",
        [agentKey],
      ),
      this.pool.query(
        `SELECT p.*, (p.connected AND t.revoked_at IS NULL
                      AND p.mode IS NOT DISTINCT FROM a.config->>'mode'
                      AND p.last_heartbeat_at > now() - make_interval(secs => $2)) AS live
         FROM runner_presence p JOIN runner_tokens t ON t.id=p.token_id JOIN agents a ON a.id=p.agent_id
         WHERE p.agent_id=$1 AND t.revoked_at IS NULL`,
        [agentKey, RUNNER_FRESH_MS / 1000],
      ),
      this.pool.query(
        "SELECT cause,reason,created_at FROM rating_skips WHERE agent_id=$1 ORDER BY id DESC LIMIT 1",
        [agentKey],
      ),
    ]);
    const t = token.rows[0];
    const p = presence.rows[0];
    const s = skip.rows[0];
    return {
      token: t ? { id: t.id, createdAt: t.created_at } : null,
      runner: p
        ? {
            connected: p.live === true,
            connectedAt: p.connected_at,
            lastHeartbeatAt: p.last_heartbeat_at,
            disconnectedAt: p.disconnected_at,
            runnerVersion: p.runner_version,
            mode: p.mode,
            teeUrl: p.tee_url,
          }
        : null,
      lastSkip: s ? { cause: s.cause, reason: s.reason, at: s.created_at } : null,
    };
  }
  /** Which of these held-out payload hashes an earlier rating already used (migration 0016). */
  async heldOutPayloadsUsed(hashes: readonly string[]): Promise<Set<string>> {
    if (!hashes.length) return new Set();
    const r = await this.pool.query("SELECT hash FROM held_out_payloads WHERE hash=ANY($1)", [
      [...hashes],
    ]);
    return new Set(r.rows.map((row) => row.hash as string));
  }
  /** Record held-out payload hashes as used, so no later rating uses them. */
  async recordHeldOutPayloads(hashes: readonly string[]): Promise<void> {
    if (!hashes.length) return;
    await this.pool.query(
      "INSERT INTO held_out_payloads(hash) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING",
      [[...hashes]],
    );
  }
  /** Record a rating the live loop chose not to queue, and why. */
  async recordRatingSkip(agentKey: string, cause: string, reason: string, c?: Connection) {
    await (c ?? this.pool).query(
      "INSERT INTO rating_skips(agent_id,cause,reason) VALUES($1,$2,$3)",
      [agentKey, cause, reason],
    );
  }
  /**
   * Queue a rating for the live loop unless the agent already has one queued or running, or one
   * was created within `minGapMs`. Returns the run id, or undefined when nothing was queued.
   */
  async enqueueIfIdle(
    agentKey: string,
    minGapMs: number,
    remote?: RemoteQuota,
  ): Promise<string | undefined> {
    return this.transaction(async (c) => {
      await c.query("SELECT 1 FROM agents WHERE id=$1 FOR UPDATE", [agentKey]);
      if (remote && (await this.remoteQuotaIn(c, agentKey, remote))) return undefined;
      const busy = await c.query(
        `SELECT 1 FROM ratings r JOIN jobs j ON j.id=r.id WHERE r.agent_id=$1
           AND (j.status IN ('queued','running') OR r.created_at > now() - make_interval(secs => $2))
         LIMIT 1`,
        [agentKey, minGapMs / 1000],
      );
      if (busy.rowCount) return undefined;
      return this.enqueueIn(c, agentKey);
    });
  }
  /**
   * Bring-your-own agents on a chain whose runner is connected and whose latest posted score
   * expires before `beforeSeconds` (unix seconds): the ones to re-rate before their score lapses.
   */
  async remoteAgentsExpiring(chainId: number, beforeSeconds: number): Promise<string[]> {
    const r = await this.pool.query(
      `SELECT a.id FROM agents a
       WHERE a.chain_id=$1 AND a.enabled AND a.config->>'kind'='remote' AND ${RUNNER_CONNECTED}
         AND (SELECT (s.signed->'attestation'->>'expiresAt')::bigint FROM attestations s
              WHERE s.agent_id=a.id ORDER BY s.created_at DESC LIMIT 1) < $2
       ORDER BY a.id`,
      [chainId, beforeSeconds],
    );
    return r.rows.map((row) => row.id as string);
  }
  /**
   * What observed breach rates are estimated from (`estimateObservedRates` in @bondedhq/shared):
   * every posted score's validity and per-group results, and every production breach on the chain.
   */
  async observedRateInputs(chainId: number): Promise<{
    periods: {
      agentId: string;
      from: number;
      to: number;
      groups: { id: string; episodes: number; breaches: number }[];
    }[];
    breaches: { agentId: string | null; at: Date | null; blocked: boolean | null }[];
  }> {
    const [periods, breaches] = await Promise.all([
      this.pool.query(
        `SELECT a.agent_id::text AS agent, (s.signed->'attestation'->>'issuedAt')::bigint AS issued,
           (s.signed->'attestation'->>'expiresAt')::bigint AS expires,
           r.report->'scoring'->'groups' AS groups
         FROM attestations s JOIN agents a ON a.id=s.agent_id JOIN ratings r ON r.id=s.id
         WHERE a.chain_id=$1`,
        [chainId],
      ),
      this.pool.query(
        "SELECT agent_id::text AS agent,occurred_at,blocked FROM handled_events WHERE chain_id=$1",
        [chainId],
      ),
    ]);
    return {
      periods: periods.rows.map((row) => ({
        agentId: row.agent,
        from: Number(row.issued),
        to: Number(row.expires),
        groups: Array.isArray(row.groups)
          ? (row.groups as { id: string; episodes: number; breaches: number }[])
          : [],
      })),
      breaches: breaches.rows.map((row) => ({
        agentId: row.agent,
        at: row.occurred_at,
        blocked: row.blocked,
      })),
    };
  }
  /**
   * Store a live check only if its observed rating is still current. Custody evidence and failures
   * survive outages within one report, but cannot be inherited by a replacement report.
   */
  async recordTeeCheck(check: {
    agentId: string;
    status: string;
    detail?: string | undefined;
    measurement?: string | undefined;
    ratedMeasurement?: string | undefined;
    ratedReportHash?: string | undefined;
    evmAddress?: string | undefined;
    /** The row version read before consulting the chain; null means no version was on record. */
    observedReportHash?: string | null;
  }) {
    await this.pool.query(
      `INSERT INTO tee_checks(agent_id,status,detail,measurement,rated_measurement,rated_report_hash,
                              evm_address,blocking_status,checked_at,verified_at)
       SELECT $1,$2,$3,$4,$5,$7,CASE WHEN $2='verified' THEN $6 END,
              CASE WHEN $2 IN ('mismatch','invalid') THEN $2 END,now(),
              CASE WHEN $2='verified' THEN now() END
       WHERE NOT $9 OR $8::text IS NULL OR EXISTS (
         SELECT 1 FROM tee_checks WHERE agent_id=$1 AND rated_report_hash IS NOT DISTINCT FROM $8)
       ON CONFLICT(agent_id) DO UPDATE SET status=$2,detail=$3,measurement=$4,
         rated_measurement=$5,rated_report_hash=$7,
         evm_address=CASE WHEN $2='verified' THEN $6
                         WHEN tee_checks.rated_report_hash IS NOT DISTINCT FROM $7
                          AND tee_checks.rated_measurement IS NOT DISTINCT FROM $5
                         THEN tee_checks.evm_address END,
         blocking_status=CASE WHEN $2 IN ('mismatch','invalid') THEN $2
                              WHEN $2 IN ('verified','unrated') THEN NULL
                              WHEN tee_checks.rated_report_hash IS NOT DISTINCT FROM $7
                               AND tee_checks.rated_measurement IS NOT DISTINCT FROM $5
                              THEN tee_checks.blocking_status END,
         checked_at=now(),
         verified_at=CASE WHEN $2='verified' THEN now()
                          WHEN tee_checks.rated_report_hash IS NOT DISTINCT FROM $7
                           AND tee_checks.rated_measurement IS NOT DISTINCT FROM $5
                          THEN tee_checks.verified_at END
       WHERE NOT $9 OR tee_checks.rated_report_hash IS NOT DISTINCT FROM $8`,
      [
        check.agentId,
        check.status,
        check.detail ?? null,
        check.measurement ?? null,
        check.ratedMeasurement ?? null,
        check.evmAddress ?? null,
        check.ratedReportHash ?? null,
        check.observedReportHash ?? null,
        Object.hasOwn(check, "observedReportHash"),
      ],
    );
  }
  /** A posted rating replaces its custody evidence and clears earlier failures. */
  async recordTeeRating(
    rating:
      | { agentId: string; ratedMeasurement: string; ratedReportHash: string; evmAddress: string }
      | { agentId: string },
    c?: Connection,
  ) {
    const q = c ?? this.pool;
    if (!("evmAddress" in rating)) {
      await q.query("DELETE FROM tee_checks WHERE agent_id=$1", [rating.agentId]);
      return;
    }
    await q.query(
      `INSERT INTO tee_checks(agent_id,status,measurement,rated_measurement,rated_report_hash,evm_address,
                              blocking_status,checked_at,verified_at)
       VALUES($1,'verified',$2,$2,$4,$3,NULL,now(),now())
       ON CONFLICT(agent_id) DO UPDATE SET status='verified',detail=NULL,measurement=$2,
         rated_measurement=$2,rated_report_hash=$4,evm_address=$3,blocking_status=NULL,
         checked_at=now(),verified_at=now()`,
      [rating.agentId, rating.ratedMeasurement, rating.evmAddress, rating.ratedReportHash],
    );
  }
  /** How far a rating has got: the episodes its worker has published (see `publish`). */
  async runProgress(runId: string): Promise<RunProgress> {
    const r = await this.pool.query(
      `SELECT count(*)::int AS done, max((payload->>'total')::int) AS total,
         min(created_at) AS started, max(created_at) AS last
       FROM events WHERE topic='rating.episode' AND payload->>'runId'=$1`,
      [runId],
    );
    const row = r.rows[0];
    return { done: row.done, total: row.total, startedAt: row.started, lastAt: row.last };
  }
  /**
   * An agent's ratings, newest first, one numbered page at a time: every attempt, failed and
   * stopped ones included, with the score of the ones that posted.
   */
  async ratingAttempts(
    agentKey: string,
    q: { page?: number; limit?: number } = {},
  ): Promise<Page<RatingAttempt>> {
    const limit = clampLimit(q.limit ?? 10);
    const total = (
      await this.pool.query("SELECT count(*)::int AS n FROM ratings WHERE agent_id=$1", [agentKey])
    ).rows[0].n as number;
    const at = pageOf(q.page, total, limit);
    const r = await this.pool.query(
      `SELECT r.id,r.status,r.error,r.agent_caused,r.agent_report,r.created_at,
         (s.signed->'attestation'->>'score')::int AS score
       FROM ratings r LEFT JOIN attestations s ON s.id=r.id
       WHERE r.agent_id=$1 ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3`,
      [agentKey, limit, at.offset],
    );
    const items = r.rows.map((row) => ({
      runId: row.id,
      status: row.status,
      error: row.error,
      agentCaused: row.agent_caused,
      agentReport: row.agent_report,
      createdAt: row.created_at,
      score: row.score,
    }));
    return { items, page: at.page, pages: at.pages, total };
  }
  /**
   * The rating that produced a posted score (found by the attestation's report hash): what kind
   * of registration it rated, and whether that registration is still the agent's current one.
   * Undefined for a score this service didn't post.
   */
  async ratingBehindScore(
    agentKey: string,
    reportHash: string,
  ): Promise<{ runId: string; kind: string; current: boolean } | undefined> {
    const row = (
      await this.pool.query(
        `SELECT r.id, r.kind, (r.config IS NOT DISTINCT FROM a.config) AS current
         FROM attestations s JOIN ratings r ON r.id=s.id JOIN agents a ON a.id=r.agent_id
         WHERE s.agent_id=$1 AND lower(s.signed->'attestation'->>'reportHash')=lower($2)
         ORDER BY s.created_at DESC LIMIT 1`,
        [agentKey, reportHash],
      )
    ).rows[0];
    return row ? { runId: row.id, kind: row.kind, current: row.current } : undefined;
  }
  /** An agent's standing after its ratings (see `AgentStanding`). */
  async agentStanding(agentKey: string): Promise<AgentStanding> {
    const row = (
      await this.pool.query("SELECT * FROM agent_standing WHERE agent_id=$1", [agentKey])
    ).rows[0];
    return {
      failuresInRow: row?.failures_in_row ?? 0,
      superseded: row?.superseded_at
        ? { since: row.superseded_at, reason: row.superseded_reason }
        : null,
      cooldownUntil: row?.cooldown_until ?? null,
    };
  }
  /**
   * Whether a remote rating may be queued for this agent now, inside a caller's transaction: no
   * cooldown, and under the per-owner, per-agent and lane-wide daily caps. Every remote rating
   * counts, whoever asked for it (owner, renewal, TEE change). Ratings are counted by what they
   * were when queued (their kind and the owner charged), so registering an agent again, as
   * another kind or under another owner, doesn't take earlier ratings off the count.
   */
  private async remoteQuotaIn(
    c: Connection,
    agentKey: string,
    quota: RemoteQuota,
  ): Promise<RemoteRefusal | undefined> {
    const now = new Date(quota.nowMs);
    const standing = (
      await c.query("SELECT cooldown_until FROM agent_standing WHERE agent_id=$1", [agentKey])
    ).rows[0];
    if (standing?.cooldown_until && standing.cooldown_until > now)
      return { refused: "cooldown", nextAt: standing.cooldown_until };
    const since = new Date(quota.nowMs - 86_400_000);
    const counts = (
      await c.query(
        `SELECT
           count(*) FILTER (WHERE r.agent_id=$1)::int AS agent,
           count(*) FILTER (WHERE r.charged_owner IS NOT DISTINCT FROM (SELECT owner FROM agents WHERE id=$1))::int AS owner,
           count(*)::int AS lane
         FROM ratings r JOIN agents a ON a.id=r.agent_id
         WHERE a.chain_id=(SELECT chain_id FROM agents WHERE id=$1)
           AND r.kind='remote' AND r.created_at>=$2`,
        [agentKey, since],
      )
    ).rows[0];
    if (counts.agent >= quota.perAgentDaily) return { refused: "agent-daily" };
    if (counts.owner >= quota.perOwnerDaily) return { refused: "owner-daily" };
    if (counts.lane >= quota.laneDaily) return { refused: "lane-daily" };
    return undefined;
  }
  /**
   * Revoke every runner token of an agent and drop its runner, without a signed request: used when
   * the agent is registered again (perhaps by a new owner), so no old token outlives it.
   */
  async revokeAllRunnerTokens(agentKey: string, c?: Connection): Promise<number> {
    const q = c ?? this.pool;
    const r = await q.query(
      "UPDATE runner_tokens SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL",
      [agentKey],
    );
    await q.query(
      "UPDATE runner_presence SET connected=false,disconnected_at=now() WHERE agent_id=$1 AND connected",
      [agentKey],
    );
    return r.rowCount ?? 0;
  }
  /** Remove an agent's TEE row, e.g. when its TEE is no longer configured. */
  async clearTee(agentId: string) {
    await this.pool.query("DELETE FROM tee_checks WHERE agent_id=$1", [agentId]);
  }
  /** The latest live TEE check for `<chain id>:<agent id>`, if there is one. */
  async teeCheck(agentId: string): Promise<TeeCheckRow | undefined> {
    const r = await this.pool.query(
      `SELECT status,detail,measurement,rated_measurement,rated_report_hash,evm_address,blocking_status,checked_at,verified_at
       FROM tee_checks WHERE agent_id=$1`,
      [agentId],
    );
    const row = r.rows[0];
    return (
      row && {
        status: row.status,
        detail: row.detail,
        measurement: row.measurement,
        ratedMeasurement: row.rated_measurement,
        ratedReportHash: row.rated_report_hash,
        evmAddress: row.evm_address,
        blockingStatus: row.blocking_status,
        checkedAt: row.checked_at,
        verifiedAt: row.verified_at,
      }
    );
  }
  /** Queue only enabled agents, locking against concurrent configuration removal. */
  async enqueue(agentId: string) {
    return this.transaction((c) => this.enqueueIn(c, agentId));
  }
  /** Queue a rating inside a caller's transaction. */
  private async enqueueIn(c: Connection, agentId: string, createdAt?: Date): Promise<string> {
    const id = randomUUID();
    const agent = await c.query(
      "SELECT config,owner FROM agents WHERE id=$1 AND enabled FOR SHARE",
      [agentId],
    );
    if (!agent.rowCount) throw new AgentNotConfiguredError("agent not configured");
    // The registration it rates and the owner it is charged to, fixed now (0018).
    const { config, owner } = agent.rows[0] as { config: { kind?: unknown }; owner: string | null };
    await c.query(
      `INSERT INTO ratings(id,agent_id,created_at,kind,charged_owner,config)
       VALUES($1,$2,coalesce($3,now()),$4,$5,$6)`,
      [
        id,
        agentId,
        createdAt ?? null,
        typeof config?.kind === "string" ? config.kind : "",
        owner,
        json(config),
      ],
    );
    await c.query("INSERT INTO jobs(id) VALUES($1)", [id]);
    await this.publish("rating.queued", { runId: id }, c);
    return id;
  }
  /**
   * Reap exhausted leases and claim one eligible job, fencing stale workers with a new token.
   * `lane` splits the queue: "remote" takes only ratings of agents their operators run (oldest
   * first among the owners who have had the fewest ratings in the last day, so one owner can't
   * crowd out the rest), "builtin" everything else; without it, any job.
   */
  async takeJob(
    chainId?: number,
    lane?: RatingLane,
  ): Promise<{ id: string; token: string } | undefined> {
    return this.transaction(async (c) => {
      const exhausted = await c.query(
        `WITH candidates AS (
        SELECT j.id FROM jobs j JOIN ratings r ON r.id=j.id JOIN agents a ON a.id=r.agent_id
        WHERE ($1::integer IS NULL OR a.chain_id=$1) AND j.attempts>=3
          AND (j.status='queued' OR (j.status='running' AND j.lease_until<now()))
        FOR UPDATE OF j SKIP LOCKED
      ) UPDATE jobs j SET status='failed',lease_until=NULL FROM candidates x WHERE j.id=x.id RETURNING j.id`,
        [chainId ?? null],
      );
      for (const row of exhausted.rows) {
        await c.query(
          "UPDATE ratings SET status='failed',error='rating abandoned after three attempts' WHERE id=$1",
          [row.id],
        );
        await this.publish("rating.failed", { runId: row.id }, c);
      }
      const r = await c.query(
        `UPDATE jobs SET status='running',token=$1,attempts=attempts+1,lease_until=now()+interval '60 seconds'
        WHERE id=(SELECT j.id FROM jobs j JOIN ratings r ON r.id=j.id JOIN agents a ON a.id=r.agent_id
          WHERE ($2::integer IS NULL OR a.chain_id=$2) AND a.enabled AND j.attempts<3
          AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<now()))
          AND ($3::text IS NULL OR (r.kind='remote') = ($3='remote'))
          ORDER BY CASE WHEN $3='remote' THEN (
              SELECT count(*) FROM ratings r2
              WHERE r2.charged_owner IS NOT DISTINCT FROM r.charged_owner AND r2.id<>r.id
                AND r2.created_at > now() - interval '1 day') ELSE 0 END,
            j.available_at
          FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING id,token`,
        [randomUUID(), chainId ?? null, lane ?? null],
      );
      return r.rows[0];
    });
  }
  /** Serialize rating writes with cancellation so an old worker cannot overwrite failed status. */
  /**
   * Remove the episodes a rating run has published so far: called when an attempt starts, so a
   * restarted run doesn't show an abandoned attempt's episodes alongside its own.
   */
  async clearRunEpisodes(runId: string, c: pg.Pool | Connection = this.pool): Promise<number> {
    const r = await c.query(
      "DELETE FROM events WHERE topic='rating.episode' AND payload->>'runId' = $1",
      [runId],
    );
    return r.rowCount ?? 0;
  }
  async withLease<T>(
    job: { id: string; token: string },
    fn: (c: Connection) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (c) => {
      const lease = await c.query(
        "SELECT id FROM jobs WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now() FOR UPDATE",
        [job.id, job.token],
      );
      if (!lease.rowCount) throw new Error("job lease lost");
      return fn(c);
    });
  }
  /** Extend a still-owned lease; a removed agent or expired token cannot renew. */
  async renew(job: { id: string; token: string }) {
    const r = await this.pool.query(
      "UPDATE jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now()",
      [job.id, job.token],
    );
    if (!r.rowCount) throw new Error("job lease lost");
  }
  /**
   * Fence completion, applying the retry cap and publishing the resulting status atomically. An
   * error is retried unless `final`, which fails the job at once (retrying can't help).
   */
  async finish(
    job: { id: string; token: string },
    error?: string,
    options?: {
      final?: boolean;
      /** The agent caused it: supersede its score and start (or double) its cooldown. */
      agentCaused?: boolean;
      /** What the agent or its runner reported, kept apart from `error`. */
      agentReport?: string;
    },
  ) {
    await this.transaction(async (c) => {
      const r = await c.query(
        `UPDATE jobs SET status=CASE WHEN $3='queued' AND attempts>=3 THEN 'failed' ELSE $3 END, lease_until=NULL, available_at=now()+interval '30 seconds'
        WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now() RETURNING id,status`,
        [job.id, job.token, error ? (options?.final ? "failed" : "queued") : "done"],
      );
      if (!r.rowCount) throw new Error("job lease lost");
      const rating = (
        await c.query(
          "UPDATE ratings SET status=$2,error=$3,agent_caused=$4,agent_report=$5 WHERE id=$1 RETURNING agent_id",
          [
            job.id,
            r.rows[0].status,
            error ?? null,
            Boolean(error && options?.agentCaused),
            options?.agentReport ?? null,
          ],
        )
      ).rows[0];
      if (error && options?.agentCaused) {
        const prior = (
          await c.query("SELECT failures_in_row FROM agent_standing WHERE agent_id=$1 FOR UPDATE", [
            rating.agent_id,
          ])
        ).rows[0];
        const failures = (prior?.failures_in_row ?? 0) + 1;
        await c.query(
          `INSERT INTO agent_standing(agent_id,failures_in_row,superseded_at,superseded_reason,cooldown_until)
           VALUES($1,$2,now(),$3,now()+make_interval(secs => $4))
           ON CONFLICT(agent_id) DO UPDATE SET failures_in_row=$2,superseded_at=now(),
             superseded_reason=$3,cooldown_until=now()+make_interval(secs => $4)`,
          [rating.agent_id, failures, error, remoteCooldownMs(failures) / 1000],
        );
      } else if (!error)
        // A complete rating posted: the new score stands, and the run of failures is over. Also
        // for an agent registered again as a built-in design: its old standing ends only here.
        await c.query("DELETE FROM agent_standing WHERE agent_id=$1", [rating.agent_id]);
      await this.publish(
        `rating.${r.rows[0].status === "queued" ? "retry" : r.rows[0].status}`,
        { runId: job.id },
        c,
      );
    });
  }
  /**
   * Record a revealed bounty for validation. Idempotent: posting the same submission again
   * returns its current status without queueing it twice.
   */
  async submitBounty(b: {
    chainId: number;
    submissionId: string;
    hunter: string;
    specUri: string;
    specYaml: string;
    spec: unknown;
  }): Promise<{ created: boolean; status: string }> {
    return this.transaction(async (c) => {
      const r = await c.query(
        `INSERT INTO bounties(chain_id,submission_id,hunter,spec_uri,spec_yaml,spec)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (chain_id,submission_id) DO NOTHING RETURNING status`,
        [b.chainId, b.submissionId, b.hunter, b.specUri, b.specYaml, json(b.spec)],
      );
      if (r.rowCount) {
        await this.publish(
          "bounty.revealed",
          { chainId: b.chainId, submissionId: b.submissionId },
          c,
        );
        return { created: true, status: r.rows[0].status as string };
      }
      const existing = await c.query(
        "SELECT status FROM bounties WHERE chain_id=$1 AND submission_id=$2",
        [b.chainId, b.submissionId],
      );
      return { created: false, status: existing.rows[0].status as string };
    });
  }
  /** Lease a waiting bounty, including exhausted jobs that still need chain reconciliation. */
  async takeBounty(chainId: number): Promise<BountyJob | undefined> {
    return this.transaction(async (c) => {
      const r = await c.query(
        `UPDATE bounties SET token=$1,attempts=attempts+CASE WHEN broadcast_pending THEN 0 ELSE 1 END,lease_until=now()+interval '60 seconds'
        WHERE (chain_id,submission_id)=(SELECT chain_id,submission_id FROM bounties
          WHERE chain_id=$2 AND status='validating' AND available_at<=now()
            AND (lease_until IS NULL OR lease_until<now())
          ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING submission_id,token,hunter,spec,verdict,attempts,broadcast_pending,pending_tx_hash,pending_nonce`,
        [randomUUID(), chainId],
      );
      const row = r.rows[0];
      return row
        ? {
            chainId,
            submissionId: String(row.submission_id),
            token: row.token as string,
            hunter: row.hunter as string,
            attempts: row.attempts as number,
            broadcastPending: row.broadcast_pending as boolean,
            pendingTxHash: row.pending_tx_hash as string | null,
            pendingNonce: row.pending_nonce === null ? null : Number(row.pending_nonce),
            spec: row.spec,
            verdict: row.verdict,
          }
        : undefined;
    });
  }
  /** Extend a bounty lease this worker still holds. */
  async renewBounty(job: BountyJob) {
    const r = await this.pool.query(
      `UPDATE bounties SET lease_until=now()+interval '60 seconds'
      WHERE chain_id=$1 AND submission_id=$2 AND token=$3 AND status='validating' AND lease_until>now()`,
      [job.chainId, job.submissionId, job.token],
    );
    if (!r.rowCount) throw new Error("bounty lease lost");
  }
  /**
   * Record the verdict before its transaction is sent, so a retry settles the same decision
   * instead of recomputing it against a library that may have changed since.
   */
  async recordBountyVerdict(job: BountyJob, verdict: unknown) {
    const r = await this.pool.query(
      `UPDATE bounties SET verdict=$4 WHERE chain_id=$1 AND submission_id=$2 AND token=$3
        AND status='validating' AND lease_until>now()`,
      [job.chainId, job.submissionId, job.token, json(verdict)],
    );
    if (!r.rowCount) throw new Error("bounty lease lost");
  }
  /** Persist send intent before broadcasting, its hash afterward, or a confirmed revert. */
  async recordBountyBroadcast(
    job: BountyJob,
    pending: boolean,
    hash: string | null = null,
    nonce: number | null = null,
  ) {
    // Clearing the pending state clears its nonce; marking it keeps a nonce already recorded.
    const r = await this.pool.query(
      `UPDATE bounties SET broadcast_pending=$4,pending_tx_hash=$5,
          pending_nonce=CASE WHEN $4 THEN COALESCE($6,pending_nonce) ELSE NULL END
        WHERE chain_id=$1 AND submission_id=$2 AND token=$3 AND status='validating' AND lease_until>now()`,
      [job.chainId, job.submissionId, job.token, pending, hash, nonce],
    );
    if (!r.rowCount) throw new Error("bounty lease lost");
  }
  /**
   * Record the decision, or schedule a retry after an error, if the lease still holds. An
   * acceptance queues a fresh rating of every enabled built-in agent on the chain in the same
   * transaction, so a bounty can't end accepted without its re-rating (docs/SPECIFICATION.md 13.1).
   * An operator-run agent is never rated on bounties (its operator would see them), so a re-rating
   * would test nothing new and only use up its caps: it is skipped with the reason on record.
   */
  async finishBounty(
    job: BountyJob,
    outcome:
      | { status: "accepted" | "rejected"; verdict: unknown; txHash: string }
      | { error: string }
      | { failed: string },
  ) {
    await this.transaction(async (c) => {
      const done = "status" in outcome;
      const r = await c.query(
        `UPDATE bounties SET status=$4,verdict=COALESCE($5::jsonb,verdict),tx_hash=COALESCE($6,tx_hash),
          error=$7,lease_until=NULL,available_at=now()+interval '30 seconds',
          broadcast_pending=CASE WHEN $4='validating' THEN broadcast_pending ELSE false END,
          pending_tx_hash=CASE WHEN $4='validating' THEN pending_tx_hash ELSE NULL END
        WHERE chain_id=$1 AND submission_id=$2 AND token=$3 AND status='validating' AND lease_until>now()
        RETURNING status`,
        [
          job.chainId,
          job.submissionId,
          job.token,
          done ? outcome.status : "failed" in outcome ? "failed" : "validating",
          done ? json(outcome.verdict) : null,
          done ? outcome.txHash : null,
          done ? null : "failed" in outcome ? outcome.failed : outcome.error,
        ],
      );
      if (!r.rowCount) throw new Error("bounty lease lost");
      if (done && outcome.status === "accepted") {
        const agents = await c.query(
          `SELECT a.id, a.config->>'kind'='remote' AS remote
           FROM agents a WHERE a.chain_id=$1 AND a.enabled`,
          [job.chainId],
        );
        for (const row of agents.rows)
          if (row.remote)
            await this.recordRatingSkip(
              row.id as string,
              "bounty",
              `bounty ${job.submissionId} was accepted, but bounty attacks aren't run against operator-run agents, so no re-rating was queued`,
              c,
            );
          else await this.enqueueIn(c, row.id as string);
      }
      await this.publish(
        `bounty.${done ? outcome.status : "failed" in outcome ? "failed" : "retry"}`,
        { chainId: job.chainId, submissionId: job.submissionId },
        c,
      );
    });
  }
  /** The WHERE clause for episode filters, up to and including event `through`. */
  private episodeWhere(f: EpisodeFilters, through: string, values: unknown[], outcome: boolean) {
    const param = (v: unknown) => `$${values.push(v)}`;
    const where = ["e.topic='rating.episode'", `e.id <= ${param(through)}::bigint`];
    if (f.runId) where.push(`e.payload->>'runId' = ${param(f.runId)}`);
    if (f.attackId) where.push(`e.payload->'episode'->>'attackId' = ${param(f.attackId)}`);
    if (f.agentId && f.chainId !== undefined)
      where.push(
        `e.payload->>'runId' IN (SELECT r.id::text FROM ratings r JOIN agents a ON a.id = r.agent_id
          WHERE a.chain_id = ${param(f.chainId)} AND a.agent_id = ${param(f.agentId)}::numeric)`,
      );
    if (f.attackClass) where.push(`e.payload->'episode'->>'attackClass' = ${param(f.attackClass)}`);
    // Only built when filtering by source: an unused parameter makes Postgres reject the query.
    const unpublished = () =>
      f.publishedIds
        ? `NOT (e.payload->'episode'->>'attackId' = ANY(${param([...f.publishedIds])}::text[]))`
        : PRIVATE_ATTACK;
    if (f.source === "held-out")
      where.push(`e.payload->'episode'->>'attackClass' IS NOT NULL AND ${unpublished()}`);
    if (f.source === "library")
      where.push(`e.payload->'episode'->>'attackClass' IS NOT NULL AND NOT (${unpublished()})`);
    if (f.since) where.push(`e.created_at >= now() - ${param(SINCE[f.since])}::interval`);
    if (outcome && f.outcome) where.push(OUTCOME_SQL[f.outcome]);
    return where.join(" AND ");
  }
  /**
   * Episode counts by outcome through event `through`, with every filter but the outcome:
   * the outcome chips show these, and the list's total is the chosen outcome's count.
   */
  async episodeCounts(f: EpisodeFilters, through: string): Promise<EpisodeCounts> {
    const values: unknown[] = [];
    const where = this.episodeWhere(f, through, values, false);
    const r = await this.pool.query(
      `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE ${OUTCOME_SQL.held})::int AS held,
        count(*) FILTER (WHERE ${OUTCOME_SQL.breach})::int AS breach,
        count(*) FILTER (WHERE ${OUTCOME_SQL.control})::int AS control
      FROM events e WHERE ${where}`,
      values,
    );
    return r.rows[0];
  }
  /**
   * One numbered page of Arena episodes, newest first, from a snapshot: only events up to
   * `through`, so page 3 shows the same rows however many episodes arrive meanwhile. `counts`
   * comes from `episodeCounts` with the same filters and snapshot.
   */
  async episodes(
    f: EpisodeFilters,
    q: { through: string; counts: EpisodeCounts; page?: number; limit?: number },
  ): Promise<Page<EpisodeSummary>> {
    const limit = clampLimit(q.limit);
    const total = f.outcome ? q.counts[f.outcome] : q.counts.total;
    const at = pageOf(q.page, total, limit);
    const values: unknown[] = [];
    const where = this.episodeWhere(f, q.through, values, true);
    const r = await this.pool.query(
      `SELECT e.id, e.payload, e.created_at, a.agent_id::text AS onchain FROM events e
        LEFT JOIN ratings r ON r.id::text = e.payload->>'runId'
        LEFT JOIN agents a ON a.id = r.agent_id
      WHERE ${where} ORDER BY e.id DESC LIMIT ${limit} OFFSET ${at.offset}`,
      values,
    );
    const items = r.rows.map((row) => episodeSummary(row));
    return { items, page: at.page, pages: at.pages, total };
  }
  /** One Arena episode with its detail, or undefined if it doesn't exist or was pruned. */
  async episode(eventId: string): Promise<EpisodeRecord | undefined> {
    const r = await this.pool.query(
      `SELECT e.id, e.payload, e.created_at, a.agent_id::text AS onchain FROM events e
        LEFT JOIN ratings r ON r.id::text = e.payload->>'runId'
        LEFT JOIN agents a ON a.id = r.agent_id
      WHERE e.topic='rating.episode' AND e.id = $1::bigint`,
      [eventId],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    const episode = row.payload.episode ?? {};
    return {
      ...episodeSummary(row),
      agent: typeof episode.agent === "string" ? episode.agent : null,
      durationMs: typeof episode.durationMs === "number" ? episode.durationMs : null,
      detail: episode.detail ?? null,
    };
  }
  /**
   * How each attack has done in the Arena episodes still on record (the events table keeps a
   * retention window): episodes, breaches, distinct runs and the latest episode, keyed by
   * attack id, plus when the oldest episode on record ran.
   */
  async attackStats(ids: readonly string[]): Promise<{
    stats: Map<string, AttackStats>;
    since: Date | null;
  }> {
    const r = await this.pool.query(
      `SELECT e.payload->'episode'->>'attackId' AS id, count(*)::int AS episodes,
        count(*) FILTER (WHERE (e.payload->'episode'->'verdict'->>'breached')::boolean IS TRUE)::int AS breaches,
        count(DISTINCT e.payload->>'runId')::int AS runs, max(e.created_at) AS last_at
      FROM events e
      WHERE e.topic='rating.episode' AND e.payload->'episode'->>'attackId' = ANY($1::text[])
      GROUP BY 1`,
      [ids],
    );
    const since = await this.pool.query(
      "SELECT min(created_at) AS since FROM events WHERE topic='rating.episode'",
    );
    return {
      stats: new Map(
        r.rows.map((row) => [
          row.id as string,
          { episodes: row.episodes, breaches: row.breaches, runs: row.runs, lastAt: row.last_at },
        ]),
      ),
      since: since.rows[0].since,
    };
  }
  /**
   * The newest event id. Counts taken through it plus a live stream opened after it miss
   * nothing and count nothing twice (ids are allocated in commit order, see `publish`).
   */
  async latestEventId(): Promise<string> {
    const r = await this.pool.query("SELECT coalesce(max(id),0)::text AS id FROM events");
    return r.rows[0].id;
  }
  /**
   * Bounties on a chain, one numbered page at a time, without payloads. Newest submission
   * first, or the largest reward first; filters by status, class, hunter or submission id.
   */
  async bounties(
    chainId: number,
    q: {
      status?: string;
      attackClass?: string;
      hunter?: string;
      submissionId?: string;
      sort?: "newest" | "reward";
      page?: number;
      limit?: number;
    } = {},
  ): Promise<Page<BountySummary>> {
    const limit = clampLimit(q.limit);
    const values: unknown[] = [chainId];
    const param = (v: unknown) => `$${values.push(v)}`;
    const where = ["chain_id=$1"];
    if (q.status) where.push(`status = ${param(q.status)}`);
    if (q.attackClass) where.push(`spec->>'class' = ${param(q.attackClass)}`);
    if (q.hunter) where.push(`lower(hunter) = lower(${param(q.hunter)})`);
    if (q.submissionId) where.push(`submission_id = ${param(q.submissionId)}::numeric`);
    const total = (
      await this.pool.query(
        `SELECT count(*)::int AS n FROM bounties WHERE ${where.join(" AND ")}`,
        values,
      )
    ).rows[0].n as number;
    const at = pageOf(q.page, total, limit);
    const order =
      q.sort === "reward"
        ? "coalesce((verdict->>'reward')::numeric, 0) DESC, submission_id DESC"
        : "submission_id DESC";
    const r = await this.pool.query(
      `SELECT submission_id,hunter,spec_uri,spec,status,verdict,tx_hash,created_at FROM bounties
      WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit} OFFSET ${at.offset}`,
      values,
    );
    const items = r.rows.map((row) => {
      const spec = row.spec as { id: string; class: string; title: string; surfaces: string[] };
      const verdict = row.verdict as { reward?: string; reason?: string } | null;
      return {
        submissionId: String(row.submission_id),
        hunter: row.hunter,
        specUri: row.spec_uri,
        attackId: spec.id,
        attackClass: spec.class,
        title: spec.title,
        surfaces: spec.surfaces,
        status: row.status,
        reward: verdict?.reward ?? null,
        reason: verdict?.reason ?? null,
        txHash: row.tx_hash,
        createdAt: row.created_at,
      };
    });
    return { items, page: at.page, pages: at.pages, total };
  }
  /** Accepted attacks plus uncertain acceptance broadcasts reserve bounty eligibility. */
  async bountyValidationAttacks(chainId: number, submissionId: string): Promise<unknown[]> {
    const r = await this.pool.query(
      `SELECT spec FROM bounties WHERE chain_id=$1 AND submission_id<>$2 AND
        (status='accepted' OR (status='validating' AND broadcast_pending AND verdict->>'decision'='accept'))`,
      [chainId, submissionId],
    );
    return r.rows.map((row) => row.spec);
  }
  /** Accepted bounty specs, which join the attack library for this chain's ratings. */
  async acceptedAttacks(chainId: number): Promise<unknown[]> {
    const r = await this.pool.query(
      "SELECT spec FROM bounties WHERE chain_id=$1 AND status='accepted' ORDER BY created_at",
      [chainId],
    );
    return r.rows.map((row) => row.spec);
  }
  /**
   * Add or replace held-out attacks for a chain (an upload of a new set). Specs keep their id;
   * uploading the same id again replaces its spec and retirement date.
   */
  async addHeldOutAttacks(
    chainId: number,
    specs: { id: string }[],
    retireAfter: Date,
  ): Promise<number> {
    await this.transaction(async (c) => {
      for (const spec of specs)
        await c.query(
          `INSERT INTO held_out_attacks (chain_id, attack_id, spec, retire_after) VALUES ($1,$2,$3,$4)
          ON CONFLICT (chain_id, attack_id) DO UPDATE SET spec=EXCLUDED.spec, retire_after=EXCLUDED.retire_after`,
          [chainId, spec.id, JSON.stringify(spec), retireAfter],
        );
    });
    return specs.length;
  }
  /** Held-out attacks not yet retired at `now`: these join every rating on the chain. */
  async activeHeldOutAttacks(chainId: number, now = new Date()): Promise<unknown[]> {
    const r = await this.pool.query(
      "SELECT spec FROM held_out_attacks WHERE chain_id=$1 AND retire_after>$2 ORDER BY attack_id",
      [chainId, now],
    );
    return r.rows.map((row) => row.spec);
  }
  /** How many held-out attacks are active, and when the first of them retires. No payloads. */
  async heldOutSummary(
    chainId: number,
    now = new Date(),
  ): Promise<{ active: number; retiresFrom: Date | null }> {
    const r = await this.pool.query(
      "SELECT count(*)::int AS active, min(retire_after) AS retires_from FROM held_out_attacks WHERE chain_id=$1 AND retire_after>$2",
      [chainId, now],
    );
    return { active: r.rows[0].active, retiresFrom: r.rows[0].retires_from };
  }
  /** One bounty's status, for a repeated reveal. */
  async bountyStatus(chainId: number, submissionId: string): Promise<string | undefined> {
    const r = await this.pool.query(
      "SELECT status FROM bounties WHERE chain_id=$1 AND submission_id=$2",
      [chainId, submissionId],
    );
    return r.rows[0]?.status as string | undefined;
  }
  /** Close idle clients and wait for borrowed clients to return. Drain streams first. */
  async close() {
    await this.pool.end();
  }
}
