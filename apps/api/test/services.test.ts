import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  Sandbox,
  createAgentVault,
  ANVIL_KEYS,
  signAttestation,
  type AgentVault,
} from "@bonded/arena";
import { Keeper, connectChain, type ServiceChain } from "@bonded/keeper";
import {
  bondedRegistryAbi,
  attestationMessage,
  quoteMessage,
  coverManagerAbi,
  coverPoolAbi,
  operatorBondAbi,
  testTokenAbi,
  mandateVaultAbi,
  type SignedQuote,
  mandateHash,
} from "@bonded/shared";
import { encodeFunctionData, keccak256, stringToBytes } from "viem";
import { createApi } from "../src/index.js";
import { postgres } from "./postgres.js";
let pg: Awaited<ReturnType<typeof postgres>>,
  sandbox: Sandbox,
  vault: AgentVault,
  chain: ServiceChain,
  app: ReturnType<typeof createApi>;
const token = "test-api-token-at-least-24-characters";
const usd = (n: number) => BigInt(n) * 1000000n;
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
beforeAll(async () => {
  pg = await postgres();
  sandbox = await Sandbox.start();
  vault = await createAgentVault(sandbox);
  chain = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.operator);
  const d = sandbox.deployment;
  await chain.send(d.usdg, testTokenAbi, "faucet", [usd(510000)]);
  await chain.send(d.usdg, testTokenAbi, "approve", [d.bond, usd(10000)]);
  await chain.send(d.bond, operatorBondAbi, "stake", [vault.agentId, usd(10000)]);
  await chain.send(d.usdg, testTokenAbi, "approve", [d.pool, usd(500000)]);
  await chain.send(d.pool, coverPoolAbi, "deposit", [usd(500000), chain.wallet.account.address]);
  const now = Number((await chain.read.getBlock()).timestamp);
  const signed = await signAttestation(
    {
      agentId: vault.agentId.toString(),
      score: 96,
      expectedLossBps: 30,
      mandateHash: mandateHash(vault.mandate),
      reportHash: `0x${"ab".repeat(32)}`,
      codeHash: `0x${"cd".repeat(32)}`,
      teeMeasurement: `0x${"00".repeat(32)}`,
      modelFamily: "unknown",
      issuedAt: now,
      expiresAt: now + 86400,
    },
    { chainId: d.chainId, registry: d.registry, attesterKey: ANVIL_KEYS.deployer },
  );
  await chain.send(d.registry, bondedRegistryAbi, "postScore", [
    attestationMessage(signed.attestation),
    signed.signature,
  ]);
  app = createApi({ db: pg.db, chain, attesterKey: ANVIL_KEYS.deployer, apiToken: token });
}, 180000);
afterAll(async () => {
  await sandbox?.stop();
  await pg?.stop();
});
it("health, authentication, input validation and missing resources", async () => {
  expect((await app.request("/health")).status).toBe(200);
  expect((await app.request("/quotes", { method: "POST" })).status).toBe(401);
  expect((await post("/quotes", { coverAmount: "-1" })).status).toBe(400);
  expect((await app.request(`/arena/runs/${randomUUID()}`)).status).toBe(404);
});
it("rejects capacity, signs an API quote, binds it and automatically pays a breach exactly once", async () => {
  const input = {
    agentId: vault.agentId.toString(),
    vault: vault.address,
    coverAmount: usd(20000).toString(),
  };
  expect((await post("/quotes", { ...input, coverAmount: usd(50001).toString() })).status).toBe(
    409,
  );
  const response = await post("/quotes", input);
  expect(response.status).toBe(201);
  const signed = (await response.json()) as SignedQuote;
  expect(signed.quote.premiumRateBps).toBe(84);
  await chain.send(chain.deployment.coverManager, coverManagerAbi, "buyCover", [
    quoteMessage(signed.quote),
    signed.signature,
  ]);
  // Production local deploy uses zero waiting period, just like the demo testnet.
  const agent = connectChain(chain.deployment, sandbox.rpcUrl, ANVIL_KEYS.agent);
  await agent.send(vault.address, mandateVaultAbi, "execute", [
    chain.deployment.usdg,
    encodeFunctionData({
      abi: testTokenAbi,
      functionName: "transfer",
      args: [chain.wallet.account.address, usd(1000)],
    }),
  ]);
  const before = await chain.read.readContract({
    address: vault.address,
    abi: mandateVaultAbi,
    functionName: "totalAssets",
  });
  const keeper = new Keeper(pg.db, chain, 0n);
  const failing = new Keeper(
    pg.db,
    {
      ...chain,
      send: async (address, abi, name, args) => {
        if (name === "fileClaim") throw new Error("temporary RPC failure");
        return chain.send(address, abi, name, args);
      },
    },
    0n,
  );
  await failing.tick();
  expect(
    (await pg.db.pool.query("SELECT 1 FROM handled_events WHERE status='pending'")).rowCount,
  ).toBeGreaterThan(0);
  await keeper.tick();
  const after = await chain.read.readContract({
    address: vault.address,
    abi: mandateVaultAbi,
    functionName: "totalAssets",
  });
  expect(after - before).toBeGreaterThan(usd(899));
  const paid = await pg.db.pool.query("SELECT * FROM handled_events WHERE status='claimed'");
  expect(paid.rowCount).toBeGreaterThan(0);
  const events = await pg.db.pool.query("SELECT * FROM events WHERE topic='claim.paid'");
  expect(events.rowCount).toBe(1);
  await new Keeper(pg.db, chain, 0n).tick();
  expect((await pg.db.pool.query("SELECT * FROM events WHERE topic='claim.paid'")).rowCount).toBe(
    1,
  );
  expect((await pg.db.pool.query("SELECT * FROM keeper_cursors")).rowCount).toBe(1);
});
it("leases exclusively, recovers crashed jobs and fences an old worker", async () => {
  const id = `${chain.deployment.chainId}:${vault.agentId}`;
  await pg.db.pool.query("INSERT INTO agents VALUES($1,$2,$3,$4)", [
    id,
    chain.deployment.chainId,
    vault.agentId.toString(),
    "{}",
  ]);
  const response = await post("/arena/runs", { agentId: vault.agentId.toString() });
  expect(response.status).toBe(202);
  const { runId } = (await response.json()) as { runId: string };
  expect(await pg.db.takeJob(chain.deployment.chainId + 1)).toBeUndefined();
  const jobs = await Promise.all([pg.db.takeJob(), pg.db.takeJob()]);
  expect(jobs.filter(Boolean)).toHaveLength(1);
  const first = jobs.find(Boolean)!;
  expect(first.id).toBe(runId);
  await pg.db.pool.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [
    runId,
  ]);
  const second = (await pg.db.takeJob())!;
  expect(second.token).not.toBe(first.token);
  await expect(pg.db.finish(first)).rejects.toThrow("lease lost");
  await pg.db.finish(second);
  expect((await app.request(`/arena/runs/${runId}/report`)).status).toBe(202);
});
it("replays durable SSE events by Last-Event-ID", async () => {
  await pg.db.publish("test.event", { hello: "world" });
  const response = await app.request("/events", { headers: { "Last-Event-ID": "0" } });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  let output = "";
  while (!output.includes("test.event")) {
    const chunk = await reader.read();
    output += new TextDecoder().decode(chunk.value);
  }
  expect(output).toContain("world");
  await reader.cancel();
});
it("runs a queued rating, persists episodes and report, posts the attestation", async () => {
  const { workOne } = await import("../src/worker.js");
  const id = `${chain.deployment.chainId}:${vault.agentId}`;
  await pg.db.pool.query("UPDATE agents SET config=$2 WHERE id=$1", [
    id,
    JSON.stringify({ kind: "hardened", mandate: vault.mandate, codeHash: `0x${"cd".repeat(32)}` }),
  ]);
  const run = await pg.db.enqueue(id);
  const worker = connectChain(chain.deployment, sandbox.rpcUrl, ANVIL_KEYS.deployer);
  await workOne(pg.db, worker, sandbox.rpcUrl, ANVIL_KEYS.deployer, console.error);
  const result = (await pg.db.pool.query("SELECT * FROM ratings WHERE id=$1", [run])).rows[0];
  expect(result.error).toBeNull();
  expect(result.status).toBe("done");
  expect(result.report.episodes.total).toBe(42);
  expect(
    (
      await pg.db.pool.query(
        "SELECT * FROM events WHERE topic='rating.episode' AND payload->>'runId'=$1",
        [run],
      )
    ).rowCount,
  ).toBe(42);
  expect((await app.request(`/agents/${vault.agentId}/score`)).status).toBe(200);
  expect((await app.request(`/arena/runs/${run}/report`)).status).toBe(200);
  const reportBody = await (await app.request(`/arena/runs/${run}/report`)).text();
  expect(keccak256(stringToBytes(reportBody))).toBe(result.attestation.attestation.reportHash);
  const tx = (await pg.db.pool.query("SELECT tx_hash FROM attestations WHERE id=$1", [run])).rows[0]
    .tx_hash;
  await pg.db.pool.query("DELETE FROM attestations WHERE id=$1", [run]);
  await pg.db.pool.query("UPDATE jobs SET status='queued',available_at=now() WHERE id=$1", [run]);
  await workOne(pg.db, worker, sandbox.rpcUrl, ANVIL_KEYS.deployer, console.error);
  expect(
    (await pg.db.pool.query("SELECT tx_hash FROM attestations WHERE id=$1", [run])).rows[0].tx_hash,
  ).toBe(tx);
}, 300000);
