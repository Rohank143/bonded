import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUNNER_FRESH_MS, type Database } from "@bonded/db";
import { postgres } from "./postgres.js";

let pg: Awaited<ReturnType<typeof postgres>>;
let db: Database;
const CHAIN = 31337;
const remote = { kind: "remote", mode: "tools" };
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
async function agent(id: number, config: unknown = remote, enabled = true) {
  await db.pool.query(
    "INSERT INTO agents(id,chain_id,agent_id,config,enabled,source,owner) VALUES($1,$2,$3,$4,$5,'user','0xowner')",
    [`${CHAIN}:${id}`, CHAIN, id, JSON.stringify(config), enabled],
  );
  return `${CHAIN}:${id}`;
}
const hello = { runnerVersion: "0.1.0", mode: "tools" };

beforeAll(async () => {
  pg = await postgres();
  db = pg.db;
}, 120_000);
afterAll(() => pg?.stop());

describe("migrations 0014 and 0015", () => {
  it("apply once, in order, and again is a no-op", async () => {
    const versions = (
      await db.pool.query("SELECT version FROM schema_migrations ORDER BY version")
    ).rows.map((r) => r.version);
    expect(versions).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    await db.migrate();
    const tables = (
      await db.pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_name IN ('runner_tokens','runner_presence','rating_skips') ORDER BY 1",
      )
    ).rows.map((r) => r.table_name);
    expect(tables).toEqual(["rating_skips", "runner_presence", "runner_tokens"]);
    const columns = (
      await db.pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='handled_events' AND column_name IN ('agent_id','breach_type','blocked','occurred_at') ORDER BY 1",
      )
    ).rows.map((r) => r.column_name);
    expect(columns).toEqual(["agent_id", "blocked", "breach_type", "occurred_at"]);
  });
});

describe("runner tokens", () => {
  it("stores only the hash, finds the live token, and a new token replaces the old one", async () => {
    const key = await agent(1);
    const first = await db.createRunnerToken(key, {
      hash: sha("one"),
      createdBy: "0xOwner",
      signedAt: 100,
    });
    expect(first).toHaveProperty("id");
    const stored = (await db.pool.query("SELECT * FROM runner_tokens WHERE agent_id=$1", [key]))
      .rows[0];
    expect(stored.token_hash).toBe(sha("one"));
    expect(JSON.stringify(stored)).not.toContain('"one"');
    expect(stored.created_by).toBe("0xowner");
    expect(await db.runnerToken(sha("one"))).toMatchObject({
      agentKey: key,
      chainId: CHAIN,
      agentId: "1",
      config: remote,
    });
    await db.createRunnerToken(key, { hash: sha("two"), createdBy: "0xowner", signedAt: 101 });
    expect(await db.runnerToken(sha("one"))).toBeUndefined();
    expect(await db.runnerToken(sha("two"))).toMatchObject({ agentKey: key });
    expect(await db.runnerToken(sha("never"))).toBeUndefined();
  });

  it("refuses a request signed no later than the last one, for create and revoke", async () => {
    const key = await agent(2);
    await db.createRunnerToken(key, { hash: sha("a"), createdBy: "x", signedAt: 200 });
    expect(
      await db.createRunnerToken(key, { hash: sha("b"), createdBy: "x", signedAt: 200 }),
    ).toEqual({ refused: "replayed" });
    expect(await db.revokeRunnerToken(key, 199)).toEqual({ refused: "replayed" });
    expect(await db.revokeRunnerToken(key, 201)).toEqual({ revoked: 1 });
    expect(await db.runnerToken(sha("a"))).toBeUndefined();
    // The revocation's signature can't be replayed either, and nothing is left to revoke.
    expect(await db.revokeRunnerToken(key, 201)).toEqual({ refused: "replayed" });
    expect(await db.revokeRunnerToken(key, 202)).toEqual({ revoked: 0 });
  });

  it("doesn't validate a token of a disabled agent", async () => {
    const key = await agent(3, remote, false);
    await db.createRunnerToken(key, { hash: sha("off"), createdBy: "x", signedAt: 1 });
    expect(await db.runnerToken(sha("off"))).toBeUndefined();
  });
});

describe("runner presence", () => {
  it("is connected while heartbeats are fresh, and a replaced connection can't touch the new one", async () => {
    const key = await agent(10);
    const t = await db.createRunnerToken(key, { hash: sha("p"), createdBy: "x", signedAt: 1 });
    if (!("id" in t)) throw new Error("no token");
    expect(await db.runnerIsConnected(key)).toBe(false);
    const first = await db.runnerConnected(t.id, { ...hello, teeUrl: "https://tee.example" });
    expect(first).toBeTruthy();
    expect(await db.runnerIsConnected(key)).toBe(true);
    const status = await db.runnerStatus(key);
    expect(status.token?.id).toBe(t.id);
    expect(status.runner).toMatchObject({
      connected: true,
      runnerVersion: "0.1.0",
      mode: "tools",
      teeUrl: "https://tee.example",
    });
    // A second connection on the same token replaces the first.
    const second = await db.runnerConnected(t.id, hello);
    expect(await db.runnerHeartbeat(first!)).toBe(false);
    await db.runnerDisconnected(first!);
    expect(await db.runnerIsConnected(key)).toBe(true);
    expect(await db.runnerHeartbeat(second!)).toBe(true);
    // Silent for longer than three heartbeats: no longer connected.
    await db.pool.query(
      "UPDATE runner_presence SET last_heartbeat_at=now() - make_interval(secs => $2) WHERE agent_id=$1",
      [key, RUNNER_FRESH_MS / 1000 + 1],
    );
    expect(await db.runnerIsConnected(key)).toBe(false);
    expect((await db.runnerStatus(key)).runner?.connected).toBe(false);
    await db.runnerHeartbeat(second!);
    expect(await db.runnerIsConnected(key)).toBe(true);
    await db.runnerDisconnected(second!);
    expect(await db.runnerIsConnected(key)).toBe(false);
  });

  it("revoking the token disconnects the runner and stops its heartbeats", async () => {
    const key = await agent(11);
    const t = await db.createRunnerToken(key, { hash: sha("r"), createdBy: "x", signedAt: 1 });
    if (!("id" in t)) throw new Error("no token");
    const connection = await db.runnerConnected(t.id, hello);
    await db.revokeRunnerToken(key, 2);
    expect(await db.runnerHeartbeat(connection!)).toBe(false);
    expect(await db.runnerIsConnected(key)).toBe(false);
    expect(await db.runnerConnected(t.id, hello)).toBeUndefined();
    expect((await db.runnerStatus(key)).token).toBeNull();
  });
});

describe("live loop", () => {
  async function connect(key: string, signedAt = 1) {
    const t = await db.createRunnerToken(key, {
      hash: sha(`${key}:${signedAt}`),
      createdBy: "x",
      signedAt,
    });
    if (!("id" in t)) throw new Error("no token");
    return db.runnerConnected(t.id, hello);
  }
  async function attest(key: string, expiresAt: number) {
    const runId = await db.enqueue(key);
    await db.pool.query("UPDATE jobs SET status='done' WHERE id=$1", [runId]);
    await db.pool.query(
      "UPDATE ratings SET status='done',created_at=now()-interval '1 day',report=$2 WHERE id=$1",
      [
        runId,
        JSON.stringify({
          scoring: { groups: [{ id: "injection", episodes: 10, breaches: 1 }] },
        }),
      ],
    );
    await db.pool.query(
      "INSERT INTO attestations(id,agent_id,signed,tx_hash) VALUES($1,$2,$3,'0x')",
      [
        runId,
        key,
        JSON.stringify({ attestation: { issuedAt: expiresAt - 30 * 86400, expiresAt } }),
      ],
    );
  }

  it("queues a re-rating only when the agent is idle", async () => {
    const key = await agent(20);
    const first = await db.enqueueIfIdle(key, 60_000);
    expect(first).toBeTruthy();
    expect(await db.enqueueIfIdle(key, 60_000)).toBeUndefined();
    await db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1", [first]);
    // Finished, but within the gap.
    expect(await db.enqueueIfIdle(key, 60_000)).toBeUndefined();
    await db.pool.query("UPDATE ratings SET created_at=now()-interval '2 minutes' WHERE id=$1", [
      first,
    ]);
    expect(await db.enqueueIfIdle(key, 60_000)).toBeTruthy();
  });

  it("finds remote agents with a connected runner whose score is about to expire", async () => {
    const soon = await agent(30);
    const later = await agent(31);
    const offline = await agent(32);
    const builtIn = await agent(33, { kind: "hardened" });
    const now = 2_000_000_000;
    await attest(soon, now + 2 * 86400);
    await attest(later, now + 10 * 86400);
    await attest(offline, now + 86400);
    await attest(builtIn, now + 86400);
    for (const k of [soon, later, builtIn]) await connect(k);
    expect(await db.remoteAgentsExpiring(CHAIN, now + 3 * 86400)).toEqual([soon]);
  });

  it("skips an offline remote agent on bounty acceptance, with the reason on record", async () => {
    const chain = 777;
    const ids = { online: `${chain}:1`, offline: `${chain}:2`, builtIn: `${chain}:3` };
    for (const [n, cfg] of [
      [1, remote],
      [2, remote],
      [3, { kind: "partial" }],
    ] as const)
      await db.pool.query(
        "INSERT INTO agents(id,chain_id,agent_id,config,source) VALUES($1,$2,$3,$4,'user')",
        [`${chain}:${n}`, chain, n, JSON.stringify(cfg)],
      );
    await connect(ids.online);
    await db.submitBounty({
      chainId: chain,
      submissionId: "5",
      hunter: "0xhunter",
      specUri: "sha256:x",
      specYaml: "x",
      spec: { id: "A1-bounty-x" },
    });
    const job = await db.takeBounty(chain);
    await db.finishBounty(job!, { status: "accepted", verdict: {}, txHash: "0xabc" });
    const queued = (
      await db.pool.query("SELECT agent_id FROM ratings WHERE agent_id LIKE $1 ORDER BY 1", [
        `${chain}:%`,
      ])
    ).rows.map((r) => r.agent_id);
    expect(queued).toEqual([ids.online, ids.builtIn]);
    const skip = (await db.runnerStatus(ids.offline)).lastSkip;
    expect(skip).toMatchObject({ cause: "bounty" });
    expect(skip?.reason).toMatch(/bounty 5 was accepted while the agent's runner was offline/);
  });

  it("reads observed-rate inputs: scores' validity and breaches with their details", async () => {
    const key = await agent(40, { kind: "hardened" });
    await attest(key, 2_000_000_000);
    await db.pool.query(
      `INSERT INTO handled_events(id,chain_id,vault,breach_id,agent_id,breach_type,blocked,occurred_at)
       VALUES('b1',$1,'0xv',1,40,2,false,to_timestamp(1990000000)),('b2',$1,'0xv',2,NULL,NULL,NULL,NULL)`,
      [CHAIN],
    );
    const inputs = await db.observedRateInputs(CHAIN);
    const mine = inputs.periods.find((p) => p.agentId === "40");
    expect(mine).toEqual({
      agentId: "40",
      from: 2_000_000_000 - 30 * 86400,
      to: 2_000_000_000,
      groups: [{ id: "injection", episodes: 10, breaches: 1 }],
    });
    expect(inputs.breaches).toEqual(
      expect.arrayContaining([
        { agentId: "40", at: new Date(1_990_000_000_000), blocked: false },
        { agentId: null, at: null, blocked: null },
      ]),
    );
  });
});
