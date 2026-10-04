import { describe, expect, it } from "vitest";
import { mandateHash, toEvmMandateParams } from "@bonded/shared";
import { buildMandate, recallAgent, rememberAgent } from "./onboarding";
import { deployment } from "../config";

const form = {
  mode: "monitor" as const,
  tokens: ["tTSLA" as const],
  destinations: ["0xd42FA5ae8949710479954ae78D1b12Ff2e50A841"],
  maxTxUsd: 5000,
  maxDailyUsd: 25000,
  maxDrawdownPct: 15,
  maxSlippagePct: 3,
  description: "Self-serve agent",
};

describe("buildMandate", () => {
  it("builds a mandate the factory accepts: tUSDG base, the router's swap, freeze on breach", () => {
    const m = buildMandate(deployment, 11n, form);
    expect(m.agentId).toBe("11");
    expect(m.baseAsset).toBe(deployment.usdg);
    expect(m.assets).toEqual([deployment.usdg, deployment.tsla]);
    expect(m.targets[0]?.address).toBe(deployment.router);
    expect(m.freezeOnBreach).toBe(true);
    expect(m.limits).toEqual({
      maxTxNotionalUsd: 5000,
      maxDailyNotionalUsd: 25000,
      maxDrawdownBps: 1500,
      maxSlippageBps: 300,
    });
    // The hash that goes on chain is the hash the API recomputes from the same JSON.
    expect(toEvmMandateParams(m).mandateHash).toBe(mandateHash(m));
  });
  it("gives a different hash for a different description, since the API checks it exactly", () => {
    const a = buildMandate(deployment, 11n, form);
    const b = buildMandate(deployment, 11n, { ...form, description: "other" });
    expect(mandateHash(a)).not.toBe(mandateHash(b));
  });
});

describe("remember and recall", () => {
  it("round-trips an onboarded agent per chain and agent id", () => {
    const mandate = buildMandate(deployment, 12n, form);
    rememberAgent(deployment.chainId, "12", { vault: "0xabc", kind: "partial", mandate });
    expect(recallAgent(deployment.chainId, "12")).toEqual({
      vault: "0xabc",
      kind: "partial",
      mandate,
    });
    expect(recallAgent(deployment.chainId, "13")).toBeUndefined();
  });
});
