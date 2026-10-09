import { describe, expect, it } from "vitest";
import { EvmMandate, demoRouterAbi, mandateHash, toEvmMandateParams } from "@bondedhq/shared";
import { getAbiItem, toFunctionSelector } from "viem";
import {
  ONBOARDING_STEPS,
  buildMandate,
  loadProgress,
  nextStep,
  parseAmount,
  recallAgent,
  rememberAgent,
  saveProgress,
  validateOnboarding,
} from "./onboarding";
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
  it("builds the same mandate as the hand-written JSON it replaced, so hashes don't change", () => {
    const handWritten = EvmMandate.parse({
      version: 1,
      chain: { family: "evm", chainId: deployment.chainId },
      agentId: "11",
      mode: "monitor",
      baseAsset: deployment.usdg,
      assets: [deployment.usdg, deployment.tsla],
      targets: [
        {
          address: deployment.router,
          selectors: [toFunctionSelector(getAbiItem({ abi: demoRouterAbi, name: "swap" }))],
        },
      ],
      destinations: form.destinations,
      limits: {
        maxTxNotionalUsd: 5000,
        maxDailyNotionalUsd: 25000,
        maxDrawdownBps: 1500,
        maxSlippageBps: 300,
      },
      freezeOnBreach: true,
      description: "Self-serve agent",
    });
    expect(buildMandate(deployment, 11n, form)).toEqual(handWritten);
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
  it("keeps what the owner declared about their own agent", () => {
    const mandate = buildMandate(deployment, 14n, form);
    const remote = { codeHash: `0x${"c".repeat(64)}`, mode: "chain" as const };
    rememberAgent(deployment.chainId, "14", { vault: "0xabc", kind: "remote", mandate, remote });
    expect(recallAgent(deployment.chainId, "14")).toEqual({
      vault: "0xabc",
      kind: "remote",
      mandate,
      remote,
    });
  });
});

describe("validateOnboarding", () => {
  const input = {
    connected: true,
    form,
    agentKey: "0xd42FA5ae8949710479954ae78D1b12Ff2e50A841",
    bond: "4000",
    deposit: "50000",
  };
  it("accepts a complete form", () => {
    expect(validateOnboarding(deployment, input)).toEqual([]);
  });
  it("rejects decimal and infinite limits, as the mandate schema will", () => {
    expect(
      validateOnboarding(deployment, { ...input, form: { ...form, maxTxUsd: 5000.5 } }).join(" "),
    ).toMatch(/Per-trade limit/);
    const infinite = { ...form, maxTxUsd: Infinity, maxDailyUsd: Infinity };
    expect(validateOnboarding(deployment, { ...input, form: infinite }).join(" ")).toMatch(
      /Per-trade limit|Daily limit/,
    );
  });
  it("rejects a description over 1,000 characters", () => {
    const long = { ...form, description: "x".repeat(1001) };
    expect(validateOnboarding(deployment, { ...input, form: long }).join(" ")).toMatch(
      /Description/,
    );
  });
  it("rejects funding typos instead of treating them as zero, and allows an explicit zero", () => {
    for (const bad of ["abc", "-5", "1.0000001"])
      expect(validateOnboarding(deployment, { ...input, bond: bad }).join(" ")).toMatch(/bond/);
    expect(validateOnboarding(deployment, { ...input, deposit: "nope" }).join(" ")).toMatch(
      /deposit/,
    );
    expect(validateOnboarding(deployment, { ...input, bond: "0", deposit: "" })).toEqual([]);
    expect(parseAmount("0")).toBe(0n);
    expect(parseAmount("abc")).toBeNull();
  });
  it("rejects a bad agent key and a daily limit below the per-trade limit", () => {
    expect(validateOnboarding(deployment, { ...input, agentKey: "me" }).join(" ")).toMatch(
      /agent key/,
    );
    const low = { ...form, maxDailyUsd: 100 };
    // One plain message each, not the schema's raw wording as well.
    expect(validateOnboarding(deployment, { ...input, form: low })).toEqual([
      "The daily limit must be at least the per-trade limit.",
    ]);
    const badRefund = { ...form, destinations: ["0x123"] };
    expect(validateOnboarding(deployment, { ...input, form: badRefund })).toEqual([
      "The refund address 0x123 isn't an address.",
    ]);
  });
});

describe("onboarding progress", () => {
  it("resumes from the first unfinished step and can be cleared", () => {
    const wallet = "0xAbC0000000000000000000000000000000000001";
    saveProgress(deployment.chainId, wallet, {
      kind: "partial",
      form,
      agentKey: wallet,
      bond: "4000",
      deposit: "50000",
      agentId: "7",
      vault: "0xvault",
      done: ["register", "vault", "faucet"],
    });
    const p = loadProgress(deployment.chainId, wallet)!;
    expect(p.agentId).toBe("7");
    expect(nextStep(p)).toBe("bond");
    expect(nextStep({ ...p, done: [...ONBOARDING_STEPS] })).toBeUndefined();
    saveProgress(deployment.chainId, wallet, null);
    expect(loadProgress(deployment.chainId, wallet)).toBeUndefined();
  });
});
