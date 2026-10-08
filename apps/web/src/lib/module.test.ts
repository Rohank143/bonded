import { describe, expect, it } from "vitest";
import {
  ERC7579_BATCH_MODE,
  moduleInstallCalls,
  erc7579Batch,
  toEvmMandateParams,
  type ModuleInstallPlan,
} from "@bonded/shared";
import { buildMandate } from "./onboarding";
import { installSteps } from "./module";
import { deployment } from "../config";

const mandate = buildMandate(deployment, 21n, {
  mode: "monitor",
  tokens: ["tTSLA"],
  destinations: ["0xd42FA5ae8949710479954ae78D1b12Ff2e50A841"],
  maxTxUsd: 5000,
  maxDailyUsd: 25000,
  maxDrawdownPct: 15,
  maxSlippagePct: 3,
  description: "Module agent",
});
const account = "0x00000000000000000000000000000000000000aa" as const;
const module = "0x00000000000000000000000000000000000000bb" as const;
function plan(accountType: "safe7579" | "erc7579"): ModuleInstallPlan {
  const calls = moduleInstallCalls({
    moduleFactory: "0x00000000000000000000000000000000000000ff",
    account,
    params: toEvmMandateParams(mandate),
    agent: "0x00000000000000000000000000000000000000cc",
    guardian: "0x00000000000000000000000000000000000000dd",
    agentId: 21n,
    accountType,
    module,
  });
  return { module, params: toEvmMandateParams(mandate), calls, execute: erc7579Batch(calls) };
}

describe("installSteps", () => {
  it("lists a Safe's three calls for one MultiSend batch, in order", () => {
    const steps = installSteps(plan("safe7579"), "safe7579");
    expect(steps.map((s) => s.label)).toEqual([
      "Create the module",
      "Install it as an executor",
      "Install it as a hook (a global hook)",
    ]);
    expect(steps[0]!.to).toBe("0x00000000000000000000000000000000000000ff");
    expect(steps.slice(1).every((s) => s.to === account)).toBe(true);
  });

  it("gives another ERC-7579 account one execute call carrying the batch", () => {
    const p = plan("erc7579");
    const steps = installSteps(p, "erc7579");
    expect(steps).toHaveLength(1);
    expect(steps[0]!.to).toBe(account);
    expect(steps[0]!.data).toBe(p.execute.data);
    expect(p.execute.mode).toBe(ERC7579_BATCH_MODE);
  });
});
