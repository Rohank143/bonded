import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
export * from "./schema.js";
export type Connection = pg.PoolClient;
export const json = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

/** SQL transactions own queue leases, ingestion cursors and durable live events. */
export class Database {
  readonly pool: pg.Pool;
  readonly orm;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 15 });
    this.pool.on("error", () => console.error("Postgres idle connection failed"));
    this.orm = drizzle(this.pool);
  }
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
  async migrate() {
    const sql = await readFile(new URL("../migrations/0001_services.sql", import.meta.url), "utf8");
    await this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7001)");
      await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)");
      const done = await c.query("SELECT 1 FROM schema_migrations WHERE version=1");
      if (!done.rowCount) {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations VALUES (1)");
      }
    });
  }
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
  async enqueue(agentId: string) {
    const id = randomUUID();
    await this.transaction(async (c) => {
      await c.query("INSERT INTO ratings(id,agent_id) VALUES($1,$2)", [id, agentId]);
      await c.query("INSERT INTO jobs(id) VALUES($1)", [id]);
      await this.publish("rating.queued", { runId: id }, c);
    });
    return id;
  }
  async takeJob(chainId?: number): Promise<{ id: string; token: string } | undefined> {
    const token = randomUUID();
    const r = await this.pool.query(
      `UPDATE jobs SET status='running', token=$1, attempts=attempts+1, lease_until=now()+interval '60 seconds'
      WHERE id=(SELECT j.id FROM jobs j JOIN ratings r ON r.id=j.id JOIN agents a ON a.id=r.agent_id
      WHERE ($2::integer IS NULL OR a.chain_id=$2) AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<now()))
      ORDER BY j.available_at FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING id,token`,
      [token, chainId ?? null],
    );
    return r.rows[0];
  }
  async renew(job: { id: string; token: string }) {
    const r = await this.pool.query(
      "UPDATE jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now()",
      [job.id, job.token],
    );
    if (!r.rowCount) throw new Error("job lease lost");
  }
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
  async close() {
    await this.pool.end();
  }
}
