import {
  ANVIL_KEYS,
  createAgentVault,
  Sandbox,
  signAttestation,
  type AgentVault,
  type VerifiedTee,
} from "@bonded/arena";
import { connectChain, type ServiceChain } from "@bonded/keeper";
import { attestationMessage, bondedRegistryAbi, mandateHash } from "@bonded/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Attest, runTeeChecks } from "../src/tee-watch.js";
import { postgres } from "./postgres.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const RATED = hash(5);
const CODE = hash(7);
let pg: Awaited<ReturnType<typeof postgres>>;
let sandbox: Sandbox;
let vault: AgentVault;
let chain: ServiceChain;
let key: string;

beforeAll(async () => {
  pg = await postgres();
  sandbox = await Sandbox.start();
  vault = await createAgentVault(sandbox);
  chain = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.operator);
  const d = sandbox.deployment;
  const now = Number((await chain.read.getBlock()).timestamp);
  const signed = await signAttestation(
    {
      agentId: vault.agentId.toString(),
      score: 96,
      expectedLossBps: 30,
      mandateHash: mandateHash(vault.mandate),
      reportHash: hash(1),
      codeHash: CODE,
      teeMeasurement: RATED,
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
  key = `${d.chainId}:${vault.agentId}`;
  await pg.db.reconcileAgents(d.chainId, [
    {
      agentId: vault.agentId.toString(),
      config: {
        kind: "hardened",
        mandate: vault.mandate,
        codeHash: CODE,
        tee: { url: "https://agent.example", composeHash: hash(9) },
      },
    },
  ]);
}, 180000);
afterAll(async () => {
  await sandbox?.stop();
  await pg?.stop();
});

const live = (measurement: string) =>
  (async () => ({ measurement }) as unknown as VerifiedTee) as Attest;

it("records each check against the measurement in the agent's on-chain score", async () => {
  expect(await runTeeChecks(pg.db, chain, live(RATED))).toBe(1);
  const ok = await pg.db.teeCheck(key);
  expect(ok).toMatchObject({ status: "verified", measurement: RATED });
  expect(ok?.verifiedAt).toBeInstanceOf(Date);

  await runTeeChecks(pg.db, chain, live(hash(6)));
  const bad = await pg.db.teeCheck(key);
  expect(bad).toMatchObject({ status: "mismatch", measurement: hash(6) });
  // The last time it passed is kept while it fails.
  expect(bad?.verifiedAt?.getTime()).toBe(ok?.verifiedAt?.getTime());
});

it("records an unreachable agent without touching the last good time", async () => {
  await runTeeChecks(pg.db, chain, live(RATED));
  const good = await pg.db.teeCheck(key);
  await runTeeChecks(pg.db, chain, async () => {
    const { TeeUnavailableError } = await import("@bonded/arena");
    throw new TeeUnavailableError("the TEE agent answered 502");
  });
  const down = await pg.db.teeCheck(key);
  expect(down).toMatchObject({ status: "unreachable", detail: "the TEE agent answered 502" });
  expect(down?.verifiedAt?.getTime()).toBe(good?.verifiedAt?.getTime());
});

it("keeps a definite failure through an outage, and a pass clears it", async () => {
  await runTeeChecks(pg.db, chain, live(hash(6)));
  expect((await pg.db.teeCheck(key))?.blockingStatus).toBe("mismatch");
  await runTeeChecks(pg.db, chain, async () => {
    const { TeeUnavailableError } = await import("@bonded/arena");
    throw new TeeUnavailableError("down");
  });
  const down = await pg.db.teeCheck(key);
  expect(down).toMatchObject({ status: "unreachable", blockingStatus: "mismatch" });
  await runTeeChecks(pg.db, chain, live(RATED));
  expect((await pg.db.teeCheck(key))?.blockingStatus).toBeNull();
});

it("records the rated measurement and the key it saw, and flags a different key", async () => {
  const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const withKey = (evmAddress: string) =>
    (async () => ({ measurement: RATED, evmAddress }) as unknown as VerifiedTee) as Attest;
  await pg.db.clearTee(key);
  await runTeeChecks(pg.db, chain, withKey(other));
  expect(await pg.db.teeCheck(key)).toMatchObject({
    status: "verified",
    ratedMeasurement: RATED,
    evmAddress: other,
  });
  // The key recorded for this rating is now the reference: a different one is a mismatch.
  await runTeeChecks(pg.db, chain, withKey("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"));
  expect(await pg.db.teeCheck(key)).toMatchObject({
    status: "mismatch",
    blockingStatus: "mismatch",
    evmAddress: other,
  });
});

it("skips agents with no TEE configured and clears their old failure", async () => {
  await pg.db.recordTeeCheck({ agentId: key, status: "invalid", ratedMeasurement: RATED });
  await pg.db.reconcileAgents(sandbox.deployment.chainId, [
    {
      agentId: vault.agentId.toString(),
      config: { kind: "hardened", mandate: vault.mandate, codeHash: CODE },
    },
  ]);
  expect(await runTeeChecks(pg.db, chain, live(RATED))).toBe(0);
  expect(await pg.db.teeCheck(key)).toBeUndefined();
});

it("skips agents with no TEE configured and agents that are disabled", async () => {
  const d = sandbox.deployment;
  await pg.db.reconcileAgents(d.chainId, [
    {
      agentId: vault.agentId.toString(),
      config: { kind: "hardened", mandate: vault.mandate, codeHash: CODE },
    },
  ]);
  expect(await runTeeChecks(pg.db, chain, live(RATED))).toBe(0);
  await pg.db.reconcileAgents(d.chainId, []);
  expect(await runTeeChecks(pg.db, chain, live(RATED))).toBe(0);
});
