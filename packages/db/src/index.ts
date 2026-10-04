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
  /** Ratings of self-serve agents on a chain since a time, for the daily cap. */
  async userRatingsSince(chainId: number, since: Date): Promise<number> {
    const r = await this.pool.query(
      `SELECT count(*)::int AS n FROM ratings r JOIN agents a ON a.id=r.agent_id
       WHERE a.chain_id=$1 AND a.source='user' AND r.created_at>=$2`,
      [chainId, since],
    );
    return r.rows[0].n as number;
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
  private async enqueueIn(c: Connection, agentId: string): Promise<string> {
    const id = randomUUID();
    const agent = await c.query("SELECT id FROM agents WHERE id=$1 AND enabled FOR SHARE", [
      agentId,
    ]);
    if (!agent.rowCount) throw new AgentNotConfiguredError("agent not configured");
    await c.query("INSERT INTO ratings(id,agent_id) VALUES($1,$2)", [id, agentId]);
    await c.query("INSERT INTO jobs(id) VALUES($1)", [id]);
    await this.publish("rating.queued", { runId: id }, c);
    return id;
  }
  /** Reap exhausted leases and claim one eligible job, fencing stale workers with a new token. */
  async takeJob(chainId?: number): Promise<{ id: string; token: string } | undefined> {
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
          ORDER BY j.available_at FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING id,token`,
        [randomUUID(), chainId ?? null],
      );
      return r.rows[0];
    });
  }
  /** Serialize rating writes with cancellation so an old worker cannot overwrite failed status. */
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
  /** Fence completion, applying the retry cap and publishing the resulting status atomically. */
  async finish(job: { id: string; token: string }, error?: string) {
    await this.transaction(async (c) => {
      const r = await c.query(
        `UPDATE jobs SET status=CASE WHEN $3='queued' AND attempts>=3 THEN 'failed' ELSE $3 END, lease_until=NULL, available_at=now()+interval '30 seconds'
        WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now() RETURNING id,status`,
        [job.id, job.token, error ? "queued" : "done"],
      );
      if (!r.rowCount) throw new Error("job lease lost");
      await c.query("UPDATE ratings SET status=$2,error=$3 WHERE id=$1", [
        job.id,
        r.rows[0].status,
        error ?? null,
      ]);
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
   * acceptance queues a fresh rating of every enabled agent on the chain in the same
   * transaction, so a bounty can't end accepted without its re-rating (docs/PLAN.md 13.1).
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
        const agents = await c.query("SELECT id FROM agents WHERE chain_id=$1 AND enabled", [
          job.chainId,
        ]);
        for (const row of agents.rows) await this.enqueueIn(c, row.id as string);
      }
      await this.publish(
        `bounty.${done ? outcome.status : "failed" in outcome ? "failed" : "retry"}`,
        { chainId: job.chainId, submissionId: job.submissionId },
        c,
      );
    });
  }
  /** Every bounty on a chain, newest first, without payloads. */
  async bounties(chainId: number): Promise<BountySummary[]> {
    const r = await this.pool.query(
      `SELECT submission_id,hunter,spec_uri,spec,status,verdict,tx_hash,created_at FROM bounties
      WHERE chain_id=$1 ORDER BY created_at DESC`,
      [chainId],
    );
    return r.rows.map((row) => {
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
