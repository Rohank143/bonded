import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ANVIL_KEYS } from "@bonded/arena";
import { AgentNotConfiguredError } from "@bonded/db";
import { connectChain, Keeper, type ServiceChain } from "@bonded/keeper";
import { parseEvmDeployment } from "@bondedhq/shared";
import { createApi } from "../src/index.js";
import { postgres } from "./postgres.js";

let pg: Awaited<ReturnType<typeof postgres>>;
const chain = connectChain(
  parseEvmDeployment(
    readFileSync(new URL("../../../contracts/evm/deployments/46630.json", import.meta.url), "utf8"),
  ),
  "http://127.0.0.1:1",
  ANVIL_KEYS.deployer,
);
const apps: ReturnType<typeof createApi>[] = [];
const token = "review-test-token-with-at-least-24-characters";
const api = () => {
  const app = createApi({ db: pg.db, chain, attesterKey: ANVIL_KEYS.deployer, apiToken: token });
  apps.push(app);
  return app;
};
beforeAll(async () => {
  pg = await postgres();
});
beforeEach(async () => {
  await pg.db.pool.query(
    "TRUNCATE agents,events,keeper_cursors,keeper_vaults,keeper_policies,handled_events CASCADE",
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
afterAll(async () => {
  await pg?.stop();
});

it("caps concurrent streams without blocking health, and releases slots on disconnect", async () => {
  const app = api();
  const responses = await Promise.all(Array.from({ length: 5 }, () => app.request("/events")));
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect((await app.request("/events")).status).toBe(503);
  expect((await app.request("/health")).status).toBe(200);
  await responses[0]!.body!.cancel();
  await expect.poll(() => pg.db.pool.totalCount - pg.db.pool.idleCount).toBe(4);
  const replacement = await app.request("/events");
  expect(replacement.status).toBe(200);
  // Unread responses are backpressured; close() must abort writes instead of waiting on readers.
  await app.close();
  expect(pg.db.pool.totalCount - pg.db.pool.idleCount).toBe(0);
  expect((await app.request("/events")).status).toBe(503);
});

it("releases a failed LISTEN client and its reserved subscriber slot", async () => {
  const app = api();
  const client = await pg.db.pool.connect();
  const release = vi.spyOn(client, "release");
  vi.spyOn(client, "query").mockRejectedValueOnce(new Error("LISTEN failed"));
  const connect = vi
    .spyOn(pg.db.pool, "connect")
    .mockImplementationOnce(() => Promise.resolve(client));
  expect((await app.request("/events")).status).toBe(503);
  expect(release).toHaveBeenCalledWith(true);
  connect.mockRestore();
  expect(pg.db.pool.totalCount - pg.db.pool.idleCount).toBe(0);
  const responses = await Promise.all(Array.from({ length: 5 }, () => app.request("/events")));
  expect(responses.every((response) => response.status === 200)).toBe(true);
});

it("recovers stream capacity after connection acquisition fails", async () => {
  const app = api();
  const connect = vi
    .spyOn(pg.db.pool, "connect")
    .mockRejectedValueOnce(new Error("connect failed"));
  expect((await app.request("/events")).status).toBe(503);
  connect.mockRestore();
  expect((await app.request("/events")).status).toBe(200);
});

it("bounds the connection wait when the database pool is saturated", async () => {
  const clients = await Promise.all(Array.from({ length: 15 }, () => pg.db.pool.connect()));
  try {
    await expect(pg.db.pool.connect()).rejects.toThrow(/timeout/i);
  } finally {
    clients.forEach((client) => client.release());
  }
}, 8000);

it("reconciles removal per chain, retains history, fences running jobs and permits re-enabling", async () => {
  const db = pg.db;
  await db.reconcileAgents(46630, [
    { agentId: "1", config: { kind: "old" } },
    { agentId: "2", config: {} },
  ]);
  await db.reconcileAgents(421614, [{ agentId: "1", config: {} }]);
  const historical = await db.enqueue("46630:1");
  await db.finish((await db.takeJob(46630))!);
  await db.pool.query("INSERT INTO attestations(id,agent_id,signed,tx_hash) VALUES($1,$2,$3,$4)", [
    historical,
    "46630:1",
    "{}",
    "historical",
  ]);
  const running = await db.enqueue("46630:1");
  const lease = (await db.takeJob(46630))!;
  const queued = await db.enqueue("46630:1");
  await db.reconcileAgents(46630, [{ agentId: "2", config: { updated: true } }]);
  await expect(db.enqueue("46630:1")).rejects.toBeInstanceOf(AgentNotConfiguredError);
  await expect(db.renew(lease)).rejects.toThrow("lease lost");
  await expect(
    db.withLease(lease, (c) =>
      c.query("UPDATE ratings SET status='running' WHERE id=$1", [running]),
    ),
  ).rejects.toThrow("lease lost");
  expect(
    (
      await db.pool.query("SELECT status FROM jobs WHERE id=ANY($1::uuid[])", [[running, queued]])
    ).rows.map((row) => row.status),
  ).toEqual(["failed", "failed"]);
  expect(
    (await db.pool.query("SELECT 1 FROM attestations WHERE id=$1", [historical])).rowCount,
  ).toBe(1);
  expect(
    (await db.pool.query("SELECT enabled FROM agents WHERE id=$1", ["421614:1"])).rows[0].enabled,
  ).toBe(true);
  const response = await api().request("/arena/runs", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: '{"agentId":"1"}',
  });
  expect(response.status).toBe(404);
  await db.reconcileAgents(46630, []);
  await expect(db.enqueue("46630:2")).rejects.toBeInstanceOf(AgentNotConfiguredError);
  await db.reconcileAgents(46630, [{ agentId: "1", config: { new: true } }]);
  expect(await db.enqueue("46630:1")).toBeTypeOf("string");
});

it("fails a job after three crashed leases and lets the next job run", async () => {
  const db = pg.db;
  await db.reconcileAgents(46630, [{ agentId: "1", config: {} }]);
  const crash = await db.enqueue("46630:1");
  let oldLease: Awaited<ReturnType<typeof db.takeJob>>;
  for (let attempt = 1; attempt <= 3; attempt++) {
    oldLease = await db.takeJob(46630);
    expect(oldLease!.id).toBe(crash);
    await db.pool.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [
      crash,
    ]);
  }
  const next = await db.enqueue("46630:1");
  expect((await db.takeJob(46630))!.id).toBe(next);
  const result = (
    await db.pool.query(
      "SELECT j.status,j.attempts,r.status AS rating_status FROM jobs j JOIN ratings r ON r.id=j.id WHERE j.id=$1",
      [crash],
    )
  ).rows[0];
  expect(result).toEqual({ status: "failed", attempts: 3, rating_status: "failed" });
  await expect(db.finish(oldLease!)).rejects.toThrow("lease lost");
  expect(
    (
      await db.pool.query(
        "SELECT 1 FROM events WHERE topic='rating.failed' AND payload->>'runId'=$1",
        [crash],
      )
    ).rowCount,
  ).toBe(1);
  expect(await db.takeJob(46630)).toBeUndefined();
});

/** A chain with a fully ingested cursor, so tests isolate claim eligibility from RPC transport. */
function claimChain(timestamp = 20n) {
  const read = {
    ...chain.read,
    getChainId: vi.fn().mockResolvedValue(46630),
    getBlockNumber: vi.fn().mockResolvedValue(10n),
    getBlock: vi.fn().mockResolvedValue({ hash: "cursor-hash", timestamp }),
    readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getPolicy") throw new Error("one policy RPC unavailable");
      if (functionName === "getBreach")
        return { claimed: false, blocked: false, lossUsd6: 100n, timestamp: 10n };
      if (functionName === "coverageWindow") return [0n, 100n];
      if (functionName === "claimWindow") return 100n;
      throw new Error("unexpected read");
    }),
  } as unknown as ServiceChain["read"];
  return { ...chain, read, send: vi.fn().mockResolvedValue(`0x${"ab".repeat(32)}`) };
}
async function seedBreach(policy = true) {
  await pg.db.pool.query("INSERT INTO keeper_cursors VALUES(46630,10,'cursor-hash',$1)", [
    chain.deployment.registry.toLowerCase(),
  ]);
  await pg.db.pool.query(
    "INSERT INTO handled_events(id,chain_id,vault,breach_id) VALUES('breach',46630,$1,0)",
    [chain.deployment.factory.toLowerCase()],
  );
  if (policy)
    await pg.db.pool.query("INSERT INTO keeper_policies VALUES(46630,1,$1)", [
      chain.deployment.factory.toLowerCase(),
    ]);
}

it("still claims when a policy's accrual read fails", async () => {
  await seedBreach();
  const fake = claimChain();
  await new Keeper(pg.db, fake, 0n).tick();
  expect(fake.send).toHaveBeenCalledWith(
    chain.deployment.claimsEngine,
    expect.anything(),
    "fileClaim",
    [1n, [0n]],
    // The send lifecycle: claim_filed_at is recorded only once the claim is broadcast.
    expect.objectContaining({ onBroadcast: expect.any(Function) }),
  );
  expect(
    (await pg.db.pool.query("SELECT status FROM handled_events WHERE id='breach'")).rows[0].status,
  ).toBe("claimed");
});
it("ignores an uncovered breach after complete policy indexing and does not re-read it", async () => {
  await seedBreach(false);
  const fake = claimChain();
  const keeper = new Keeper(pg.db, fake, 0n);
  await keeper.tick();
  expect(
    (await pg.db.pool.query("SELECT status,error FROM handled_events WHERE id='breach'")).rows[0],
  ).toEqual({ status: "ignored", error: "no policy covers this breach within its claim window" });
  vi.mocked(fake.read.readContract).mockClear();
  await keeper.tick();
  expect(fake.read.readContract).not.toHaveBeenCalled();
});
it("keeps no-match breaches pending while policy indexing is at the same timestamp", async () => {
  await seedBreach(false);
  const fake = claimChain(10n);
  await new Keeper(pg.db, fake, 0n).tick();
  expect(
    (await pg.db.pool.query("SELECT status,error FROM handled_events WHERE id='breach'")).rows[0],
  ).toEqual({ status: "pending", error: "waiting for policy indexing past breach timestamp" });
});
it("ignores a breach whose historical policy coverage window excludes it", async () => {
  await seedBreach();
  const fake = claimChain();
  const original = fake.read.readContract;
  fake.read.readContract = vi
    .fn()
    .mockImplementation((args) =>
      args.functionName === "coverageWindow" ? Promise.resolve([11n, 100n]) : original(args),
    ) as typeof original;
  await new Keeper(pg.db, fake, 0n).tick();
  expect(
    (await pg.db.pool.query("SELECT status FROM handled_events WHERE id='breach'")).rows[0].status,
  ).toBe("ignored");
});
it("keeps transaction failures pending so eligible claims can retry", async () => {
  await seedBreach();
  const fake = claimChain();
  fake.send.mockRejectedValueOnce(new Error("RPC unavailable"));
  const keeper = new Keeper(pg.db, fake, 0n);
  await keeper.tick();
  expect(
    (await pg.db.pool.query("SELECT status FROM handled_events WHERE id='breach'")).rows[0].status,
  ).toBe("pending");
  await keeper.tick();
  expect(
    (await pg.db.pool.query("SELECT status FROM handled_events WHERE id='breach'")).rows[0].status,
  ).toBe("claimed");
});

it("answers browsers only from allowed web origins", async () => {
  const app = createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: token,
    webOrigins: ["https://bonded.example"],
  });
  apps.push(app);
  const preflight = (origin: string) =>
    app.request("/quotes", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
  const allowed = await preflight("https://bonded.example");
  expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://bonded.example");
  expect(allowed.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain(
    "authorization",
  );
  expect(
    (await preflight("https://evil.example")).headers.get("Access-Control-Allow-Origin"),
  ).toBeNull();

  const health = await app.request("/health", { headers: { Origin: "https://bonded.example" } });
  expect(health.headers.get("Access-Control-Allow-Origin")).toBe("https://bonded.example");
  // A rejected POST still carries the header, so the page can show "unauthorized".
  const rejected = await app.request("/arena/runs", {
    method: "POST",
    headers: { Origin: "https://bonded.example", "Content-Type": "application/json" },
    body: "{}",
  });
  expect(rejected.status).toBe(401);
  expect(rejected.headers.get("Access-Control-Allow-Origin")).toBe("https://bonded.example");
});

it("sends no CORS headers when no web origin is configured", async () => {
  const response = await api().request("/health", {
    headers: { Origin: "https://bonded.example" },
  });
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
});
