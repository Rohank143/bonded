import { ScriptedHardenedAgent } from "@bonded/demo-agents";
import { bondedRegistryAbi, teeMeasurement } from "@bonded/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAttackLibrary, rateAgent, Sandbox, type VerifiedTee } from "../src/index.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const CODE = hash(77);
const tee: VerifiedTee = {
  measurement: teeMeasurement({
    mrTd: "01".repeat(48),
    rtMr0: "02".repeat(48),
    rtMr1: "03".repeat(48),
    rtMr2: "04".repeat(48),
    composeHash: "ab".repeat(32),
  }),
  composeHash: `0x${"ab".repeat(32)}`,
  codeHash: CODE,
  evmAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  solanaPublicKey: "11111111111111111111111111111112",
  tcbStatus: "UpToDate",
  mrTd: "01".repeat(48),
  rtMr0: "02".repeat(48),
  rtMr1: "03".repeat(48),
  rtMr2: "04".repeat(48),
};

let sandbox: Sandbox;
const attacks = loadAttackLibrary().slice(0, 1);

beforeAll(async () => {
  sandbox = await Sandbox.start();
}, 120_000);
afterAll(async () => {
  await sandbox?.stop();
});

describe("rating an agent that runs in a TEE", () => {
  it("puts the measurement in the posted attestation and the report", async () => {
    const result = await rateAgent(sandbox, {
      agent: new ScriptedHardenedAgent(),
      attacks: attacks,
      controls: 1,
      codeHash: CODE,
      tee,
    });
    expect(result.attestation.attestation.teeMeasurement).toBe(tee.measurement);
    expect(result.attestation.attestation.codeHash).toBe(CODE);
    expect(result.report.tee).toMatchObject({
      measurement: tee.measurement,
      evmAddress: tee.evmAddress,
      tcbStatus: "UpToDate",
    });
    expect(result.posted.posted).toBe(true);
    const stored = await sandbox.publicClient.readContract({
      address: sandbox.deployment.registry,
      abi: bondedRegistryAbi,
      functionName: "scoreOf",
      args: [BigInt(result.attestation.attestation.agentId)],
    });
    expect(stored.teeMeasurement).toBe(tee.measurement);
  }, 120_000);

  it("leaves the measurement empty without a TEE", async () => {
    const result = await rateAgent(sandbox, {
      agent: new ScriptedHardenedAgent(),
      attacks: attacks,
      controls: 1,
    });
    expect(result.attestation.attestation.teeMeasurement).toBe(`0x${"0".repeat(64)}`);
    expect(result.report.tee).toBeNull();
  }, 120_000);

  it("refuses a TEE that runs different code than the one rated", async () => {
    await expect(
      rateAgent(sandbox, {
        agent: new ScriptedHardenedAgent(),
        attacks: attacks,
        codeHash: hash(78),
        tee,
      }),
    ).rejects.toThrow(/different code/);
    await expect(
      rateAgent(sandbox, { agent: new ScriptedHardenedAgent(), attacks: attacks, tee }),
    ).rejects.toThrow(/different code/);
  }, 120_000);
});
